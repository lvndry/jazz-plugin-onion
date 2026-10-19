# jazz-plugin-onion

A [Jazz](https://github.com/lvndry/jazz) plugin that lets an agent search and read Tor onion
services. Requests go through your local Tor proxy, and the plugin reaches only `.onion` addresses.

## What it does

The plugin adds 2 read-only tools:

- **`search`** finds onion sites matching a query and returns up to 30 results, 10 by default.
  Each result has a title, an `.onion` URL and a snippet.
  - The plugin searches [Ahmia](https://ahmia.fi) through its own onion address. Ahmia filters
    abuse material out of its index.
  - Arguments: `query` (required) and `limit`.
- **`fetch_page`** reads one onion page and returns its title, readable text and up to 40 onion
  links. It returns up to 12,000 characters of text by default and at most 50,000.
  - It loads no images, scripts or styles.
  - It skips content that isn't text. A response larger than 5 MB is cut off.
  - Arguments: `url` (required) and `maxChars`.

Each result is marked as untrusted third-party data before it reaches the model.

### Network behavior

- **Hostnames resolve inside Tor.** The plugin hands the `.onion` hostname to Tor unresolved, so no
  DNS lookup leaves your machine.
- **Only v3 `.onion` hosts.** Clearnet URLs are refused, and so is any redirect that leaves the
  onion network. The plugin can't be used as an anonymous proxy for regular websites.
- **Your requests look like Tor Browser's.** Each request uses Tor Browser's user agent and sends
  no cookies or referrer.
- **No dependencies.** The SOCKS5 and HTTP client is about 400 lines on Node built-ins
  (`node:net`, `node:tls`).

## Requirements

You need a running Tor SOCKS proxy:

```sh
brew install tor
brew services start tor        # listens on 127.0.0.1:9050
```

On Linux, install the `tor` package and enable its service. To use Tor Browser's proxy instead,
set `JAZZ_TOR_PROXY=127.0.0.1:9150`.

## Install

Install it straight from GitHub. You don't need to clone or build anything. Installing doesn't
trust or enable the plugin; those are separate steps:

```sh
jazz plugin add lvndry/jazz-plugin-onion                  # download and install
jazz plugin inspect com.jazz.plugins.onion                # review the declarations
jazz plugin trust com.jazz.plugins.onion                  # allow this exact code to run
jazz plugin enable com.jazz.plugins.onion --agent <id-or-name>   # allow network access, enable for one agent
```

To pin a version, use `jazz plugin add lvndry/jazz-plugin-onion@v0.1.0`.

The manifest is `jazz-plugin.json`: id `com.jazz.plugins.onion`, entry `src/index.ts`. It declares
the following:

- 2 tools, both read-only.
- The tools send the model's input over the network.
- The Ahmia onion host is the plugin's only network destination.

## Configuration

| Variable         | Default          | Purpose                              |
| ---------------- | ---------------- | ------------------------------------ |
| `JAZZ_TOR_PROXY` | `127.0.0.1:9050` | `host:port` of the Tor SOCKS5 proxy. |

## Things to know

- **The first connection is slow.** Reaching an onion service for the first time takes 45–60s.
  After that, requests take a few seconds. Each request times out after 90s.
- **Pages are hostile input.** Onion sites are a good place to plant prompt injections. Enable this
  plugin on a dedicated research agent, not one that also has shell, file-write or messaging tools.
- **Ahmia isn't the whole dark web.** It indexes only what it can reach and filters what it lists.
  To read a site Ahmia doesn't list, pass its URL to `fetch_page` directly.
- **You're responsible for what you access.** Use this for research, threat intelligence, leak
  monitoring and journalism, and follow the laws where you are.

## Develop

```sh
bun install
bun test
bun run typecheck
```

The tests run offline against a fake Tor proxy.

## License

MIT
