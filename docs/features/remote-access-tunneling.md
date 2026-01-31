# Feature Spec: Remote Access via Tunneling

**Status:** Planned
**Phase:** 2 (Chat Interface Integration)
**Created:** 2026-01-31
**Last Updated:** 2026-01-31

## Overview

Enable remote access to the Witness MCP server running inside Obsidian, allowing Claude (Desktop, Web, Mobile, Code) to connect from anywhere, not just localhost.

## Problem Statement

Currently, the Witness MCP server listens on `localhost:3000`. This works for Claude Desktop on the same machine using `mcp-remote`, but doesn't support:
- Claude.ai web interface
- Claude mobile apps (iOS/Android)
- Claude on other devices
- True "AI companion" use case where Claude can reach your vault from anywhere

## Solution: Tiered Tunneling Approach

### Tier 1: Quick Tunnel (Built-in, Zero Config)

**What:** Cloudflare Quick Tunnel embedded in the plugin via `node-cloudflared` npm package.

**User Experience:**
1. Toggle "Enable Remote Access" in settings
2. Plugin automatically creates tunnel on startup
3. Random URL displayed in settings (e.g., `https://fancy-words.trycloudflare.com/mcp`)
4. User copies URL and configures Claude

**Limitations:**
- URL changes every time Obsidian restarts
- Must reconfigure Claude after each restart
- Good for trying out, not for permanent use

**Implementation:**
```typescript
import { Tunnel } from "cloudflared";

// On plugin load (if enabled)
const tunnel = Tunnel.quick({ port: 3000 });
tunnel.once("url", (url) => {
  this.settings.tunnelUrl = url;
  this.saveSettings();
  // Update settings UI
});
```

### Tier 2: Named Tunnel (External, Stable URL)

**What:** User sets up `cloudflared` externally with their own domain.

**User Experience:**
1. User follows documentation to set up named tunnel
2. Tunnel runs as system service, points to `localhost:3000`
3. Plugin doesn't need to know about it - just serves on localhost
4. User configures Claude with their permanent URL (e.g., `https://mcp.example.com/mcp`)

**Why Plugin Doesn't Need Changes:**
The named tunnel is infrastructure that sits outside the plugin:
```
cloudflared (running separately as service)
    ↓ watches localhost:3000
    ↓ forwards to mcp.example.com

Witness plugin (inside Obsidian)
    ↓ just listens on localhost:3000
    ↓ doesn't know or care about the tunnel
```

## Technical Research Summary

### Claude Remote MCP Support

Claude supports remote MCP servers across all platforms:
- **Claude.ai Web:** Settings → Connectors → Add custom connector → paste URL
- **Claude Desktop:** Same GUI or JSON config with `mcp-remote`
- **Claude Code:** `claude mcp add --transport http witness https://your-url.com/mcp`
- **Claude Mobile:** Can use configured servers (can't add new ones on mobile)

**Transport:** Streamable HTTP is the recommended transport (HTTP POST/GET). SSE is being deprecated.

**Authentication Options:**
1. Authless - no auth (risky for public internet)
2. Bearer Token - static API key in header
3. OAuth 2.0 - full user auth flow

### Tunneling Options Evaluated

| Option | Stable URL | Zero Config | Notes |
|--------|-----------|-------------|-------|
| Cloudflare Quick Tunnel | ❌ Random | ✅ Yes | Good for trying out |
| Cloudflare Named Tunnel | ✅ Yes | ❌ No | Requires domain on Cloudflare |
| ngrok Free | ✅ Yes | ❌ Account needed | 1 static domain free, pure JS SDK |
| Tailscale Funnel | ✅ Yes | ❌ No | No JS SDK, requires Tailscale |
| Custom Relay Service | ✅ Yes | ✅ Yes | Requires running infrastructure |

**Decision:** Start with Cloudflare Quick Tunnel (built-in) + documentation for Named Tunnel (external).

### node-cloudflared Package

- **Package:** `cloudflared` on npm ([GitHub](https://github.com/JacobLinCool/node-cloudflared))
- **What it does:** Wraps `cloudflared` binary, auto-downloads on first use (~50MB)
- **Quick Tunnel API:**
  ```typescript
  import { Tunnel } from "cloudflared";

  const tunnel = Tunnel.quick({ port: 3000 });
  tunnel.once("url", (url) => console.log(url));
  tunnel.once("connected", () => console.log("ready"));
  ```
- **Limitation:** Only supports Quick Tunnels via API. Named tunnels require manual `cloudflared` setup.

### Named Tunnel Setup (for Documentation)

One-time setup for users who want stable URLs:

```bash
# 1. Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# 2. Authenticate with Cloudflare account
cloudflared login
# Opens browser, select domain, downloads cert

# 3. Create named tunnel
cloudflared tunnel create witness
# Creates credentials file and UUID

# 4. Route DNS to tunnel
cloudflared tunnel route dns witness mcp.yourdomain.com
# Creates CNAME record automatically

# 5. Create config file (~/.cloudflared/config.yml)
cat > ~/.cloudflared/config.yml << EOF
tunnel: witness
credentials-file: /Users/you/.cloudflared/<UUID>.json

ingress:
  - hostname: mcp.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
EOF

# 6. Run tunnel (or install as service)
cloudflared tunnel run witness

# 7. (Optional) Run as background service
cloudflared service install
```

## Settings UI Design

```
┌─────────────────────────────────────────────────────────────┐
│ Remote Access                                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ☑ Enable Quick Tunnel                                       │
│                                                             │
│ Your MCP URL:                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ https://fancy-words-here.trycloudflare.com/mcp          │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                              [Copy URL]     │
│                                                             │
│ Status: ● Connected                                         │
│                                                             │
│ ⚠️ This URL changes when Obsidian restarts.                 │
│    For a permanent URL, see the documentation below.        │
│                                                             │
│ [📖 Set up permanent URL with Cloudflare]                   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Security                                                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Auth Token:                                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ••••••••••••••••••••••••••                              │ │
│ └─────────────────────────────────────────────────────────┘ │
│ [Generate New Token]  [Copy Token]                          │
│                                                             │
│ ℹ️ Add this token to your Claude configuration:             │
│    --header "Authorization: Bearer <token>"                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Quick Tunnel Integration

1. **Add dependency:** `npm install cloudflared`

2. **Settings interface updates:**
   ```typescript
   interface WitnessSettings {
     // ... existing
     enableQuickTunnel: boolean;
     tunnelUrl: string | null;
     authToken: string;
   }
   ```

3. **Tunnel lifecycle management:**
   - Start tunnel when plugin loads (if enabled)
   - Stop tunnel when plugin unloads
   - Handle tunnel disconnection/reconnection
   - Store URL in settings for display

4. **Settings tab UI:**
   - Toggle for enabling tunnel
   - Display current URL with copy button
   - Status indicator (connecting/connected/error)
   - Link to documentation for permanent setup

5. **Auth token support:**
   - Generate random token on first run
   - Validate `Authorization: Bearer <token>` header
   - Settings UI to view/regenerate token

### Phase 2: Documentation

Create user documentation for:
1. Using Quick Tunnel for testing
2. Setting up permanent URL with Cloudflare Named Tunnel
3. Configuring Claude Desktop/Web/Code with the URL
4. Security best practices

## Security Considerations

### Authentication

Before exposing the MCP server to the internet, **authentication is required**:

```typescript
// In handleMCPRequest
const authHeader = req.headers['authorization'];
const expectedToken = `Bearer ${this.settings.authToken}`;

if (authHeader !== expectedToken) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return;
}
```

### Risks to Document

1. **Anyone with URL + token can access your vault** - emphasize keeping token secret
2. **Quick Tunnel URLs are guessable** - random words, but still public
3. **No rate limiting** - could add in future
4. **Full vault access** - MCP tools can read/write any file

### Mitigations

1. Auth token required (not optional)
2. Token regeneration available
3. Clear warnings in UI about security implications
4. Documentation on restricting to specific paths (future feature)

## Claude Configuration Examples

### Claude Desktop (JSON)

```json
{
  "mcpServers": {
    "witness": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://fancy-words.trycloudflare.com/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add --transport http witness \
  https://fancy-words.trycloudflare.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Claude.ai Web

1. Go to Settings → Connectors → Add custom connector
2. Enter URL: `https://fancy-words.trycloudflare.com/mcp`
3. Add header: `Authorization: Bearer YOUR_TOKEN_HERE`

## Future Considerations

### Potential Tier 3: Managed Relay Service

A future option could be a hosted relay service (`mcp.witness.app`):
- Plugin connects OUT via WebSocket to relay
- Relay assigns stable URL path per user
- Zero config for users, but requires running infrastructure
- Could be monetized

**Architecture:**
```
User's Obsidian ←WebSocket→ Relay Server ←HTTP→ Claude
                            (mcp.witness.app)
```

**Pros:**
- True zero-config
- Stable URLs without user setup
- Works behind any NAT/firewall

**Cons:**
- Privacy concerns (traffic flows through relay)
- Infrastructure cost and maintenance
- Single point of failure

**Decision:** Defer to Phase 3 or later. Quick Tunnel + documentation covers most use cases.

## Dependencies

- `cloudflared` npm package: Cloudflare tunnel wrapper
- No changes to existing MCP server code (just add auth check)

## References

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Named Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
- [node-cloudflared GitHub](https://github.com/JacobLinCool/node-cloudflared)
- [Claude Remote MCP Servers](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- [MCP Remote Server Connection](https://modelcontextprotocol.io/docs/develop/connect-remote-servers)

---

*This spec was developed through conversation exploring tunneling options, Claude's remote MCP capabilities, and the tradeoffs between ease-of-use and stability.*
