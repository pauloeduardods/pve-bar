#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A stand-in for the Proxmox VE API over HTTPS, for tools/footprint.sh bench.

Serves only the read-only GETs pved and pvectl make, with the shapes of the
Proxmox API documentation: /cluster/resources, a guest's status/current,
rrddata and agent/get-fsinfo, /version and /access/permissions. The numbers
wander between requests like real ones. Any PVEAPIToken is accepted.

    proxmox.py --cert cert.pem --key key.pem --guests 100 --port-file port

prints nothing; it writes the port it listens on (127.0.0.1) to --port-file.
"""

import argparse
import json
import math
import random
import re
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

GIB = 1024**3
NODE = "pve"


class Cluster:
    """One node with `guests` guests; every third one a container, every
    fourth one stopped, the even VMs with the guest agent."""

    def __init__(self, guests: int):
        self.rng = random.Random(42)
        self.lock = threading.Lock()
        self.start = time.monotonic()
        self.guests = []
        for i in range(guests):
            lxc = i % 3 == 1
            self.guests.append(
                {
                    "vmid": 100 + i,
                    "kind": "lxc" if lxc else "qemu",
                    "name": f"guest-{100 + i}",
                    "running": i % 4 != 3,
                    "cpu": self.rng.random() * 0.4,
                    "mem": 0.3 + self.rng.random() * 0.5,
                    "maxmem": GIB if lxc else 4 * GIB,
                    "maxcpu": 2 if lxc else 4,
                    "agent": not lxc and (100 + i) % 2 == 0,
                }
            )
        self.by_id = {g["vmid"]: g for g in self.guests}

    def step(self):
        with self.lock:
            for g in self.guests:
                g["cpu"] = min(1.0, max(0.0, g["cpu"] + self.rng.uniform(-0.08, 0.08)))
                g["mem"] = min(0.98, max(0.05, g["mem"] + self.rng.uniform(-0.02, 0.02)))

    def resources(self):
        self.step()
        running = [g for g in self.guests if g["running"]]
        busy = sum(g["cpu"] * g["maxcpu"] for g in running)
        out = [
            {
                "id": f"node/{NODE}", "type": "node", "node": NODE, "status": "online",
                "cpu": min(1.0, busy * 0.3 / 64 + 0.03), "maxcpu": 64,
                "mem": 300 * GIB, "maxmem": 512 * GIB,
                "disk": 38 * GIB, "maxdisk": 100 * GIB,
                "uptime": int(time.monotonic() - self.start) + 86400, "level": "",
            },
            {"id": f"storage/{NODE}/local", "type": "storage", "node": NODE,
             "status": "available", "storage": "local"},
        ]
        for g in self.guests:
            on = g["running"]
            out.append(
                {
                    "id": f"{g['kind']}/{g['vmid']}", "type": g["kind"], "vmid": g["vmid"],
                    "node": NODE, "name": g["name"],
                    "status": "running" if on else "stopped",
                    "cpu": g["cpu"] if on else 0, "maxcpu": g["maxcpu"],
                    "mem": int(g["mem"] * g["maxmem"]) if on else 0, "maxmem": g["maxmem"],
                    "disk": 0, "maxdisk": 32 * GIB, "template": 0,
                    "uptime": int(time.monotonic() - self.start) if on else 0,
                }
            )
        return out

    def counter(self, g, scale):
        """Bytes since start: the integral of a rate that rises and falls."""
        t = time.monotonic() - self.start
        base, period = 2000 + (g["vmid"] % 7) * 15000, 60 + (g["vmid"] % 5) * 40
        return int(scale * base * (1.2 * t + period * (1 - math.cos(t / period))))

    def status(self, g):
        on = g["running"]
        data = {
            "status": "running" if on else "stopped", "vmid": g["vmid"], "name": g["name"],
            "uptime": int(time.monotonic() - self.start) if on else 0,
            "cpu": g["cpu"] if on else 0, "cpus": g["maxcpu"],
            "mem": int(g["mem"] * g["maxmem"]) if on else 0, "maxmem": g["maxmem"],
            "disk": 0, "maxdisk": 32 * GIB,
            "netin": self.counter(g, 1.0) if on else 0,
            "netout": self.counter(g, 0.3) if on else 0,
            "diskread": self.counter(g, 0.05) if on else 0,
            "diskwrite": self.counter(g, 0.2) if on else 0,
            "ha": {"managed": 0},
        }
        if g["kind"] == "qemu":
            data.update({"qmpstatus": data["status"], "agent": 1 if g["agent"] else 0,
                         "running-qemu": "8.1.5", "running-machine": "pc-q35-8.1+pve0"})
        else:
            data.update({"type": "lxc", "swap": 0, "maxswap": 512 * 1024**2})
        return data

    def rrd(self, g):
        end = int(time.time()) // 60 * 60
        points = []
        for i in range(70):
            t = end - (69 - i) * 60
            swing = math.sin(t / 600 + g["vmid"])
            points.append(
                {
                    "time": t, "cpu": max(0.0, g["cpu"] + 0.1 * swing), "maxcpu": g["maxcpu"],
                    "mem": int((g["mem"] + 0.03 * swing) * g["maxmem"]), "maxmem": g["maxmem"],
                    "disk": 0, "maxdisk": 32 * GIB,
                    "netin": 2000 + 1500 * swing, "netout": 600 + 400 * swing,
                    "diskread": 0, "diskwrite": 4096.0,
                }
            )
        points.append({"time": end + 60})
        return points

    @staticmethod
    def fsinfo(g):
        used = (20 + g["vmid"] % 60) / 100
        return {
            "result": [
                {"name": "sda1", "mountpoint": "/", "type": "ext4",
                 "used-bytes": int(used * 32 * GIB), "total-bytes": 32 * GIB,
                 "disk": [{"bus-type": "scsi", "bus": 0, "target": 0, "unit": 0,
                           "serial": "drive-scsi0", "dev": "/dev/sda1"}]},
                {"name": "loop0", "mountpoint": "/snap/core22/1380", "type": "squashfs",
                 "used-bytes": 77594624, "total-bytes": 77594624, "disk": []},
            ]
        }


GUEST = re.compile(r"^/api2/json/nodes/([^/]+)/(qemu|lxc)/(\d+)/(status/current|rrddata|agent/get-fsinfo)$")


def handler(cluster: Cluster):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def reply(self, code, data=None):
            body = json.dumps({"data": data}).encode() if code == 200 else b""
            self.send_response(code)
            self.send_header("Content-Type", "application/json;charset=UTF-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.headers.get("Authorization", "").startswith("PVEAPIToken="):
                return self.reply(401)
            path = urlsplit(self.path).path
            if path == "/api2/json/cluster/resources":
                return self.reply(200, cluster.resources())
            if path == "/api2/json/version":
                return self.reply(200, {"version": "8.2.4", "release": "8.2", "repoid": "faa83925"})
            if path == "/api2/json/access/permissions":
                audit = {"Sys.Audit": 1, "VM.Audit": 1, "Datastore.Audit": 1}
                return self.reply(200, {"/": audit, "/vms": audit})
            m = GUEST.match(path)
            g = m and cluster.by_id.get(int(m.group(3)))
            if not g or m.group(1) != NODE or m.group(2) != g["kind"]:
                return self.reply(404)
            what = m.group(4)
            if what == "status/current":
                return self.reply(200, cluster.status(g))
            if what == "rrddata":
                return self.reply(200, cluster.rrd(g))
            if not (g["agent"] and g["running"]):
                # What Proxmox answers when the agent is off or not running.
                return self.reply(500)
            return self.reply(200, cluster.fsinfo(g))

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--guests", type=int, default=100)
    ap.add_argument("--port-file", required=True)
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(Cluster(args.guests)))
    server.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    with open(args.port_file, "w") as f:
        f.write(str(server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main()
