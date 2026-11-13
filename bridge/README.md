# NightPOS print bridge

A single-file, zero-dependency program that runs on a PC in the venue and relays raw ESC/POS bytes from the NightPOS web
app to thermal printers. Because it sits on the LAN, printing keeps working when the internet is down. The cloud server
only stores *routing* (printer name, kind, paper width); the real addresses live in this PC's config file.

```
tablet browser ──(http, 127.0.0.1 only)──> bridge ──(TCP :9100 or Windows share)──> printer
```

The bridge listens on `127.0.0.1` only, so the browser must run on the **same computer** as the bridge. A tablet that
is a different device cannot reach it (see "Tablets" below).

## Requirements

Node.js 24 or newer (it runs the TypeScript file directly: `node bridge/print-bridge.ts`). Nothing to `npm install`.

## Setup

1. Copy `bridge.config.example.json` to `bridge.config.json` (anywhere; pass `--config <path>` or set `BRIDGE_CONFIG`).
2. Generate a token: `node bridge/print-bridge.ts --gen-token` and paste it into `"token"` (min. 16 characters).
3. Set `"allowedOrigins"` to the exact origin(s) of NightPOS as shown in the browser address bar, for example
   `https://pos.example.com`. No path, no wildcard. Add `http://localhost:3500` only for development.
4. List your printers under `"printers"`. Each has a **name** (what you type in NightPOS Admin) and one of:
   - `{ "name": "Receipt", "type": "tcp", "host": "192.168.1.50", "port": 9100 }`: a LAN printer on raw port 9100.
   - `{ "name": "Kitchen", "type": "share", "path": "\\\\localhost\\EPSON_TM" }`: a USB printer shared in Windows.
5. Test the wiring before touching NightPOS: `node bridge/print-bridge.ts --self-test Receipt` prints a small test page
   (text plus a checker pattern that proves raster printing works).
6. Start it: `node bridge/print-bridge.ts --config bridge.config.json`. Check it with `--status` (needs the bridge running).

In NightPOS: header **Printing** (on the venue PC) → bridge address `http://127.0.0.1:9101`, paste the token, **Test
connection** (it lists the printer names the bridge knows). A manager then adds printers under **Admin → Printers**
using exactly those names, and a *Test print* button per printer.

### Finding the printer address

- **LAN printers**: print the printer's self-test sheet (usually hold FEED while powering on) and read its IP address,
  or look in the router's device list. Give it a fixed IP (DHCP reservation) so the config stays valid. Port is 9100.
- **USB printers on Windows**: install the driver, open *Settings → Printers & scanners → your printer → Printer
  properties → Sharing*, tick **Share this printer**, and note the share name (for example `EPSON_TM`). The path is
  `\\localhost\EPSON_TM` (in JSON every backslash is doubled: `"\\\\localhost\\EPSON_TM"`). Raw ESC/POS bytes are
  written straight to that path, bypassing the driver's page formatting.

## Running at startup (Windows)

Task Scheduler, run whether the user is logged on or not:

```
schtasks /Create /TN "NightPOS Print Bridge" /SC ONLOGON /RL HIGHEST ^
  /TR "cmd /c cd /d C:\nightpos && node bridge\print-bridge.ts --config C:\nightpos\bridge.config.json >> C:\nightpos\bridge.log 2>&1"
```

Alternatives: NSSM (`nssm install NightPOSBridge node.exe C:\nightpos\bridge\print-bridge.ts --config ...`) or
`pm2 start` for a real service. Rotate `bridge.log`: every print job is logged to stdout (time, printer, bytes, origin).

## Protocol

| Request | Notes |
|---|---|
| `GET /status` | `{ ok, version, printers: [names] }` |
| `POST /print` `{ printer, data }` | `printer` is a configured name; `data` is base64 ESC/POS bytes. `{ ok, bytes }` or `{ ok:false, error }` |

Every request needs the header `x-bridge-token`. Limits: 512 KB per job, 240 requests/minute, 20 bad tokens/minute
before a lockout, 5 s to connect and 10 s total per print.

## Security model

Any web page you visit can send requests to `127.0.0.1`, so the bridge assumes hostile callers:

- shared **token** on every request (constant-time comparison) and a **strict Origin allowlist**: a request from any other
  origin gets 403 and no CORS headers; the `OPTIONS` preflight answers `Access-Control-Allow-Private-Network: true`.
- the **Host header must be loopback** with the bridge's port (blocks DNS rebinding).
- printers are addressed **by name only**. A request can never supply a host, port or share path, so a compromised cloud
  server or web page cannot make the bridge connect to arbitrary machines.
- jobs to one printer are serialised, sizes and rates are capped, and it refuses to start with a weak token or a
  wildcard origin.
- it binds to `127.0.0.1` whatever the config says. Do not put it behind a LAN-facing proxy.

## Browser notes

- **Chrome / Edge**: an https page may call `http://127.0.0.1` (loopback counts as a secure context). Recent versions
  may ask once to allow "local network access" for the site: allow it.
- **Firefox**: allows it, but a strict "block mixed content" or tracking-protection setting can block the call; if
  printing fails only in Firefox, check the shield icon or use Chrome/Edge on the venue PC.
- **Safari / iOS**: blocks https → `http://127.0.0.1` as mixed content. Use a Chromium browser, serve NightPOS over
  plain http on the LAN, or fall back to the browser print dialog.

## Tablets

A tablet cannot reach another computer's `127.0.0.1`. Either run the browser on the venue PC (the usual cashier setup), or
run one bridge per device that has a printer attached. A shared LAN bridge would need TLS and per-device auth and is out of
scope here: the loopback-only design is deliberate.
