# Onion search for Jazz

A Jazz plugin that lets an agent search and read Tor onion services.

- `search` queries the [Ahmia](https://ahmia.fi) onion index. Ahmia filters abuse material out of its results.
- `fetch_page` reads one `.onion` page and returns its title, readable text and onion links. It loads no images or scripts.

Every request goes through your local Tor SOCKS5 proxy, and the hostname is resolved inside Tor. The tools only reach v3 `.onion` hosts, so a redirect to the clearnet is refused.

## Setup

```sh
brew install tor
brew services start tor        # SOCKS proxy on 127.0.0.1:9050
```

If you use Tor Browser's proxy instead, set `JAZZ_TOR_PROXY=127.0.0.1:9150`.

```sh
jazz plugin add ./jazz-plugin-onion      # or owner/repo once published
jazz plugin inspect com.lvndry.onion
jazz plugin trust com.lvndry.onion
jazz plugin enable com.lvndry.onion --agent <agent>
```

## Notes

- Opening a connection to an onion service for the first time takes 45-60s. Once the circuit exists, a request takes a few seconds. Requests time out after 90s.
- Onion pages are adversarial. Results are labeled as untrusted data, but don't enable this plugin on an agent that also has shell, file-write or messaging tools.

## Development

```sh
bun install
bun test
bun run typecheck
```
