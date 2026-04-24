# @millbot/openclaw-imessage-quiet

Mention-gated iMessage channel plugin for OpenClaw. Speaks only when spoken to.

## What it does

This plugin connects OpenClaw to iMessage with strict mention-gating: the agent only responds when explicitly @mentioned, in both DMs and group chats. No persistent threads, no session state, no heartbeat routing.

Key differences from the built-in `imessage` channel:

- **Mention required everywhere** -- DMs and groups both require an explicit @mention
- **No self-invocation** -- `is_from_me` messages are always dropped (immune to echo loop regressions)
- **No session persistence** -- no `recordInboundSession`, no thread bindings, no delivery recovery
- **No attachments** -- media is disabled at both the watch and capability layer
- **No participant leakage** -- group member lists are never passed to the agent
- **Default allowlist** -- DM and group policies default to `allowlist`, not `open`
- **Rate limiting** -- per-conversation and global dispatch rate limits prevent mention flooding

## Installation

```bash
openclaw plugins install @millbot/openclaw-imessage-quiet
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "channels": {
    "imessage": { "enabled": false },
    "imessage-quiet": {
      "enabled": true,
      "accounts": {
        "default": {
          "cliPath": "/opt/homebrew/bin/imsg",
          "dmPolicy": "allowlist",
          "groupPolicy": "allowlist",
          "allowFrom": ["+15551234567"],
          "groupAllowFrom": ["chat_id:42"],
          "mentionPatterns": ["@millbot"]
        }
      }
    }
  }
}
```

**Important**: Disable the built-in `imessage` channel when using this plugin. Running both simultaneously causes duplicate responses.

### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `cliPath` | `imsg` | Path to the imsg CLI binary |
| `dbPath` | (auto) | Path to iMessage chat.db |
| `dmPolicy` | `allowlist` | DM access: `open`, `allowlist`, or `disabled` |
| `groupPolicy` | `allowlist` | Group access: `open`, `allowlist`, or `disabled` |
| `allowFrom` | `[]` | DM allowlist entries |
| `groupAllowFrom` | `[]` | Group allowlist entries |
| `mentionPatterns` | `[]` | Custom @mention patterns |
| `maxInboundLength` | `8000` | Max inbound message length |
| `rateLimitPerConversation` | `5` | Max dispatches per conversation per 60s |
| `rateLimitGlobal` | `20` | Max dispatches globally per 60s |

## Development

```bash
# Build
npm run build

# Test
npm test
```

## License

MIT
