# Tor-only network mode

DACAIS now routes every public HTTP(S) request made by the running server
through Tor and refuses to start unless the Tor Project identifies the route as
a Tor exit. Direct HTTP remains available only for explicit loopback hosts so
the local UI, PostgreSQL, Ollama, and local tunnels continue to work.

This is a behavioral constraint requested by the owner. There is no application
setting which silently falls back to clearnet.

## Configure Tor

Run a Tor client on the same machine. Its `torrc` should include:

```text
ClientOnly 1
SocksPort 127.0.0.1:9050
SafeSocks 1
TestSocks 1
```

Then set these non-secret values in `.env`:

```dotenv
TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050
TOR_CHECK_URL=https://check.torproject.org/api/ip
ROUTING_POLICY=local-only
```

`socks5h://` is mandatory. The `h` means the destination hostname is handed to
the proxy instead of being resolved through the workstation's normal DNS path.
`SafeSocks 1` gives Tor a second fail-closed check for unsafe SOCKS clients.

Start the Tor client before `pnpm dev`. The server stops at startup if the SOCKS
listener is unavailable, verification cannot complete, or the returned route
is not Tor. `/health` and `/api/status` report `networkPrivacy: "tor-only"` once
startup succeeds; they do not expose the exit IP.

## What the runtime enforces

- OpenAI, Anthropic, Hugging Face, remote Ollama, public web tools, downloads,
  investment research, and background source-feed fetches use the installed
  Tor transport.
- Destination DNS for these public requests is delegated to the SOCKS proxy.
- Redirects stay on the same Tor-backed transport.
- Route-identifying forwarding and referrer headers are removed.
- Common child-process clients receive Tor-only proxy environment variables;
  inherited proxy configuration and wildcard `NO_PROXY` values are discarded.
- Built-in RunPod SSH and media SSH tunnels are blocked because their raw TCP
  transport is not yet verifiably carried by Tor. Tor-routed HTTPS and local
  loopback media remain available.
- PostgreSQL must be on loopback; a remote `DATABASE_URL` is rejected before a
  socket is opened.
- Local URLs under `localhost`, `*.localhost`, `127.0.0.0/8`, and `::1` remain
  direct. Private LAN addresses are not treated as loopback and are sent to Tor.

## Identity and containment limits

Tor changes the network route; it does not make an authenticated account
anonymous. An OpenAI, Anthropic, Hugging Face, RunPod, GitHub, or other API key
still identifies its account to that provider. For the lowest identity
exposure, keep `ROUTING_POLICY=local-only`, use local Ollama, and leave remote
provider keys unset.

The process-wide guard covers the server and normal agent tools. Standalone
scripts started separately do not inherit it. A child binary can also ignore
proxy environment variables and open a raw socket. If the requirement is that
*no process can ever bypass Tor*, run DACAIS in a dedicated VM/container whose
firewall permits public egress only to a separately isolated Tor gateway. Do
not describe the application guard alone as whole-machine anonymity.

Tor also does not prevent correlation through prompt content, uploaded files,
timestamps, provider accounts, cookies, browser fingerprinting, local malware,
or a compromised endpoint. Avoid inserting identifying information when the
task requires separation from your real-world identity.

The Tor Project documents both the default SOCKS listener and `SafeSocks` /
`TestSocks` leak checks:

- <https://support.torproject.org/little-t-tor/troubleshooting/check-for-leaks/>
- <https://support.torproject.org/little-t-tor/getting-started/tor-client-central-server/>
