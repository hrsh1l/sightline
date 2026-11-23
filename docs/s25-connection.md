# Connecting a Samsung Galaxy S25 (Chrome) to Sightline

Sightline runs as a single Node server on the laptop (UI, `/api` and the `/ws` WebSocket on one origin,
port 3000). The phone opens it in Chrome. Camera and microphone (`getUserMedia`) work **only in a secure
context**: a page served over `https://`, or from `localhost`. On plain `http://` to any other host,
Chrome leaves `navigator.mediaDevices` undefined, so the app can't ask for the camera at all
([MDN: getUserMedia, security](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)).

That rules out the obvious shortcut:

> **Do not use `http://<laptop-LAN-IP>:3000`** (for example `http://192.168.1.20:3000`). It is not a secure
> context, so the camera and mic don't work, and the server's access gate refuses non-localhost hosts
> anyway. Use one of the two methods below.

| Method | When | Needs |
|---|---|---|
| **A. USB + port forwarding (recommended)** | Development, demos at a desk | USB data cable, USB debugging |
| **A6. Wireless debugging + port forwarding** | No cable, phone and laptop on the same Wi-Fi | Android 11+ Wireless debugging, one-time pairing |
| **B. Wireless HTTPS tunnel** | Different networks, or Wi-Fi that blocks device-to-device traffic | A tunnel tool, `ACCESS_TOKEN` in `.env` |

Sources: [Android: access a local server](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server),
[Chrome DevTools: access local servers](https://developer.chrome.com/docs/devtools/remote-debugging/local-server).

---

## A. USB development (recommended)

### A1. Enable USB debugging on the S25 (one time)

1. On the phone, open **Settings > About phone > Software information**.
2. Tap **Build number** 7 times, then enter your PIN if asked. You'll see "Developer mode has been turned on".
3. Go back to **Settings**. Scroll to the bottom and open **Developer options**, then turn on **USB debugging**.
   - If the toggle is greyed out or adb never sees the phone, check **Settings > Security and privacy >
     Auto Blocker**. Samsung's Auto Blocker can block commands sent over a USB cable. Turn it off while
     you develop and turn it back on afterwards.

### A2. Install adb on the laptop (macOS, one time)

```sh
brew install --cask android-platform-tools
adb version          # confirms the install
```

### A3. Connect and authorise

1. Connect the phone with a **data-capable** USB-C cable. Some cables only charge.
2. Unlock the phone. When the **"Allow USB debugging?"** prompt shows the computer's RSA key fingerprint,
   tick "Always allow from this computer" and tap **Allow**.
3. Check the connection:

   ```sh
   adb devices
   ```

   The phone must be listed with the state **`device`**:

   ```
   List of devices attached
   R5XXXXXXXXX    device
   ```

   `unauthorized` means the prompt was not accepted yet; see Troubleshooting. An empty list means the
   cable, USB mode or Auto Blocker is the problem.

### A4. Start the server and forward the port

```sh
npm run dev                       # server on http://127.0.0.1:3000 (HOST=127.0.0.1 is enough)
adb reverse tcp:3000 tcp:3000     # phone's localhost:3000 -> laptop's localhost:3000
adb reverse --list                # should list tcp:3000 tcp:3000
```

On the phone, open Chrome and type the full URL **`http://localhost:3000`**.

Why this works: on the phone, `localhost` normally means **the phone itself**. `adb reverse` makes an
exception for one port: connections to port 3000 on the phone are carried over USB to port 3000 on the
laptop. Every other `localhost` port still points at the phone. Chrome treats `http://localhost` as a
secure context, so the camera and mic prompts work. The WebSocket (`ws://localhost:3000/ws`) goes through
the same forwarded port. The server also counts these requests as loopback, so no access token is needed.

Notes:
- Forwarding is tied to the current USB connection. After you unplug, reboot, or restart the adb server
  (`adb kill-server`), run `adb reverse tcp:3000 tcp:3000` again.
- To clean up: `adb reverse --remove tcp:3000` removes one rule, `adb reverse --remove-all` removes them all.
- If you change `PORT`, forward that port instead: `adb reverse tcp:<PORT> tcp:<PORT>`.

### A5. Alternative without the adb CLI: Chrome DevTools port forwarding

USB debugging must still be enabled and authorised (A1, A3).

1. On the laptop, open desktop Chrome at **`chrome://inspect/#devices`**.
2. Make sure **Discover USB devices** is ticked and the S25 is listed. Accept the USB debugging prompt
   on the phone if it appears.
3. Click **Port forwarding...**. Enter **Port** `3000` and **IP address and port** `localhost:3000`.
4. Tick **Enable port forwarding**, then click **Done**.
5. Keep desktop Chrome running with the `chrome://inspect` tab (or DevTools for the phone tab) open while
   you test. Forwarding depends on that DevTools connection to the device.
6. On the phone, open `http://localhost:3000` in Chrome.

Use either `adb reverse` or Chrome port forwarding for port 3000, not both at once.

### A6. Wireless debugging (no cable, same Wi-Fi)

This is `adb reverse` over Wi-Fi instead of USB. The phone still opens `http://localhost:3000`, so it is
still a secure context, the server still sees loopback requests, and no tunnel or access token is needed.
Requires Android 11+ (the S25 qualifies) and adb from A2.

> Status: written from Android's documented wireless-debugging flow; not yet tried on the S25 in this project.

1. Put the phone and the laptop on the **same Wi-Fi network**. Guest, hotel, corporate or university networks
   often block device-to-device traffic ("client isolation"); if pairing never connects, use method B.
2. On the phone: **Settings > Developer options > Wireless debugging** → turn it on → **Allow** for this
   network. (Developer options must already be enabled: see A1.)
3. Tap **Pair device with pairing code**. The phone shows an *IP address & port* and a *six-digit code*.
4. On the laptop (use the IP:port from the pairing dialog):

   ```sh
   adb pair 192.168.1.23:37123        # enter the six-digit code when asked
   ```

   One-time: the laptop is remembered under **Paired devices**.
5. Close the pairing dialog. The main Wireless debugging screen shows a **different** *IP address & port*
   (the connection port). Connect to that one:

   ```sh
   adb connect 192.168.1.23:41234
   adb devices                        # shows 192.168.1.23:41234   device
   ```

   (`adb mdns services` may list the phone automatically if mDNS works on your network.)
6. Start the server and forward the port exactly as in A4:

   ```sh
   npm run dev
   adb reverse tcp:3000 tcp:3000
   adb reverse --list
   ```

   If a USB connection is also active, pick the device: `adb -s 192.168.1.23:41234 reverse tcp:3000 tcp:3000`.
7. On the phone, open **`http://localhost:3000`** in Chrome.

Notes:
- The connection port changes whenever Wireless debugging is toggled or the phone changes network, and the
  phone turns Wireless debugging off when it leaves that network. When the app stops connecting, check
  `adb devices`, re-run `adb connect <ip:port>` (no re-pairing needed) and `adb reverse tcp:3000 tcp:3000`.
- Screen-off or battery saver can drop the link. Keep the phone awake while testing.
- Audio and frames travel over Wi-Fi, so latency may be a little higher and less steady than over USB.
  Compare the diagnostics latency values between USB and wireless before choosing one for the demo.
- Turn Wireless debugging off when you finish.

---

## B. Wireless HTTPS (no cable)

The phone needs a **trusted HTTPS origin** that reaches the laptop. A tunnel gives you that. The server
**refuses every non-localhost host unless `ACCESS_TOKEN` is set**, so a tunnel can't expose an
unauthenticated proxy to the billable Gemini API.

### B1. Set an access token

```sh
openssl rand -hex 32          # copy the output
```

In `.env` (git-ignored; never commit it or paste it in chat):

```
ACCESS_TOKEN=<the hex string>
HOST=127.0.0.1                # keep this: the tunnel client connects to localhost
```

### B2. Run a production build

Use the built app behind a tunnel: it is faster to load on the phone and the hot-reload channel isn't
needed. (`npm run dev` also works through a tunnel once `ACCESS_TOKEN` is set — the server then relaxes
Vite's Host allow-list because its own access gate already protects every request. Without a token,
non-localhost hosts are refused either way.)

```sh
npm run build
npm start                     # http://127.0.0.1:3000
```

### B3. Start a tunnel (pick one)

- **Cloudflare quick tunnel** (no account needed):

  ```sh
  cloudflared tunnel --url http://localhost:3000
  ```

  It prints a random `https://<random>.trycloudflare.com` URL that changes every run. Cloudflare says
  quick tunnels are for testing and development only and have no uptime guarantee. The quick-tunnel page
  does not mention WebSockets. Cloudflare Tunnel normally proxies WebSocket upgrades, but confirm `/ws`
  connects (see Troubleshooting).
- **Tailscale Serve**: needs a Tailscale account, the Tailscale app signed in on the phone, and HTTPS
  certificates enabled for the tailnet. `tailscale serve 3000` makes the app reachable only inside your
  tailnet. Check `tailscale serve --help`, because the syntax differs between versions. Don't use
  **Funnel**: it makes the app public.
- **ngrok**: needs an ngrok account and authtoken. Run `ngrok http 3000`. The free plan may show a
  warning page before your app loads.

Follow each provider's terms of service.

### B4. Open it on the phone

1. On the phone, open **`https://<tunnel-host>/?access=<ACCESS_TOKEN>`** once. The server sets an
   HttpOnly cookie (valid 12 hours) and redirects to the same page without the token in the URL.
2. From then on, open `https://<tunnel-host>/` normally.
3. The WebSocket works without extra setup. The client uses same-origin relative URLs, so on an https
   page it connects to `wss://<tunnel-host>/ws`, and the cookie authorises it.

### B5. Safety rules for tunnels

- **Never run a tunnel without `ACCESS_TOKEN` set.** (The server refuses non-localhost hosts anyway, but
  keep both protections.)
- Anyone who has the token can use the app through your Gemini API key, which costs you money. Don't
  share the `?access=` link, and use a new token for each demo.
- **Stop the tunnel (Ctrl+C) as soon as the demo ends.** To revoke access, change `ACCESS_TOKEN` and
  restart the server. Existing cookies stop working.

### Last resort only: Chrome flag

Phone Chrome has `chrome://flags/#unsafely-treat-insecure-origin-as-secure` ("Insecure origins treated
as secure"). It makes an `http://<LAN-IP>:3000` origin act like a secure context. **Not recommended**:
it weakens browser security, is easy to forget, and the server's access gate still requires
`ACCESS_TOKEN` for a LAN host. If you ever use it, remove the entry when you're done.

---

## Troubleshooting

### No camera/microphone permission prompt
1. **Check the URL.** It must be exactly `http://localhost:3000` (USB) or `https://...` (tunnel). Any other
   `http://` address cannot use the camera.
2. **Check whether the site was denied before.** In phone Chrome, tap the icon left of the address bar,
   then **Permissions** (or **Site settings**), and set **Camera** and **Microphone** to Allow. You can
   also go to Chrome **⋮ > Settings > Site settings > Camera** (and **Microphone**), find the site under
   Blocked, and change it to Allow. Then reload.
3. **Check Android's permissions for Chrome.** Go to **Settings > Apps > Chrome > Permissions > Camera**
   (and **Microphone**) and choose "Allow only while using the app" or "Ask every time".
4. **Check the system-wide privacy switches.** In the quick panel, or under **Settings > Security and
   privacy > Privacy**, make sure **Camera access** and **Microphone access** are on.
5. **Check whether another app is holding the camera.** Close the Camera app, video-call apps and other
   Chrome tabs that use the camera. If the app says the camera "may be in use by another app", close
   those apps and tap Start again. Restarting Chrome can help.

### The app says it needs a secure page ("insecure context")
The page is not `https` or `localhost`. Use method A or B above. If you used USB, run
`adb reverse --list` to check the rule is still there, and make sure you typed `localhost`, not the
laptop's IP address.

### The page loads but the WebSocket fails
Inspect the phone tab from desktop Chrome (`chrome://inspect/#devices` > **inspect**) and look at
Console/Network for the `/ws` status. The server terminal also logs `ws_rejected` with a reason.

| Status | Meaning | Fix |
|---|---|---|
| **403** | The Origin check failed (`reason: origin`), or a non-localhost host was used while `ACCESS_TOKEN` is unset (`reason: access`) | Set `ACCESS_TOKEN` and restart the server. If the tunnel rewrites the Host header, add `ALLOWED_ORIGINS=https://<tunnel-host>` to `.env` and restart |
| **401** | The access cookie is missing or expired | Open `https://<tunnel-host>/?access=<token>` again. Private tabs and cleared cookies lose it |
| **503** | Too many sessions (`MAX_CONCURRENT_SESSIONS`, default 2) | Close other tabs or devices running the app. A dropped connection is cleaned up within about 40 s (heartbeat) |

Also check:
- USB: run `adb reverse --list`. If the rule is missing, run `adb reverse tcp:3000 tcp:3000` again.
- On the laptop, `curl http://localhost:3000/api/health` should return JSON with `"ok":true`.
- The server terminal is still running and shows no errors.
- The tunnel supports WebSockets and is still running. Quick-tunnel URLs change every run.

### `adb devices` shows `unauthorized` or nothing
1. Unlock the phone and look for the "Allow USB debugging?" prompt. Accept it.
2. If no prompt appears, go to **Developer options > Revoke USB debugging authorisations**, unplug the
   cable, plug it back in, and accept the new prompt.
3. Use a data-capable cable and a direct USB port (not an unpowered hub).
4. Pull down the notification shade, tap the USB notification, and choose **File transfer** (Transferring
   files / Android Auto). Some machines only detect the device in this mode.
5. Check that Samsung **Auto Blocker** is off (see A1).
6. Run `adb kill-server && adb devices`.

### Assistant audio is silent
1. **Tap the screen.** Chrome only starts audio after a tap. If the app shows a "tap to resume" prompt,
   tap it, especially after switching apps or locking the screen.
2. **Turn up the media volume.** Press volume up while audio is playing, or go to **Settings > Sounds and
   vibration > Volume > Media**.
3. **Check Bluetooth.** Audio may be going to connected Bluetooth headphones or a car. Disconnect them or
   choose the right output from the quick panel media output control.
4. Make sure the phone is not in Do Not Disturb with media muted, and that Chrome's site sound setting
   allows sound.

### What desktop testing does not prove
Chrome DevTools device emulation, or a desktop webcam, doesn't prove the app works on the S25. It doesn't
reproduce the real rear camera (facing mode, multiple lenses, rotation and resolution), Android
permission dialogs, backgrounding, audio routing, or performance. Test on the phone itself.
