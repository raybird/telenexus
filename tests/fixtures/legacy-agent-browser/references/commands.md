# Custom browser executable
agent-browser --extension ...        # Load browser extension (repeatable)
agent-browser --ignore-https-errors  # Ignore SSL certificate errors
agent-browser --help                 # Show help (-h)
agent-browser --version              # Show version (-V)
agent-browser <command> --help       # Show detailed help for a command
```

## Debugging
```bash
agent-browser --headed open example.com  # Show browser window
agent-browser --cdp 9222 snapshot        # Connect via CDP port
agent-browser connect 9222               # Alternative: connect command
agent-browser console                    # View console messages
agent-browser console --clear            # Clear console
agent-browser errors                     # View page errors
agent-browser errors --clear             # Clear errors
agent-browser highlight @e1              # Highlight element
agent-browser trace start                # Start recording trace
agent-browser trace stop trace.zip       # Stop and save trace
```

## Environment Variables
```bash
AGENT_BROWSER_SESSION="mysession"             # Default session name
AGENT_BROWSER_EXECUTABLE_PATH="/path/chrome"  # Custom browser path
AGENT_BROWSER_EXTENSIONS="/ext1,/ext2"        # Comma-separated extension paths
AGENT_BROWSER_PROVIDER="browserbase"          # Cloud browser provider
AGENT_BROWSER_STREAM_PORT="9223"              # WebSocket streaming port
AGENT_BROWSER_HOME="/path/to/agent-browser"   # Custom install location
```
