# MCP Setup And Harness Integration

Vessel is designed to act as the browser runtime that your external agent harness drives.

## Recommended Flow

1. Launch Vessel
2. Open Settings (`Ctrl+,`) to confirm MCP status, copy the endpoint, or change the MCP port
3. Optional: set an Obsidian vault path or session preferences
4. Start Hermes Agent, OpenClaw, Codex, or another MCP client and configure it to connect to `http://127.0.0.1:<mcpPort>/mcp` with the bearer token from `~/.config/vessel/mcp-auth.json`
5. Use the Supervisor panel in Vessel's sidebar to pause the agent, change approval mode, review pending approvals, checkpoint, or restore the browser session while the harness runs
6. Use the Bookmarks panel to organize saved pages into folders and expose those bookmarks back to the agent over MCP

## Integration Notes

- Vessel exposes browser control to external agents through its local MCP server
- The default MCP port is `3100`
- Harnesses should treat Vessel as the persistent, human-visible browser rather than launching a separate browser session
- Approval policy is controlled live from the Supervisor panel rather than a separate global settings screen
- Settings show MCP runtime status, active endpoint, startup warnings, and allow changing the MCP port with an immediate server restart
- Agents can selectively disable ad blocking for a problematic tab, reload, retry, and turn blocking back on later
- Agents can persist authenticated state with named sessions, for example `github-logged-in`, and reload that state in later runs
- If you set an Obsidian vault path in Settings, harnesses can write markdown notes directly into that vault via Vessel memory tools

## High-Value MCP Surfaces

Two especially useful grounding surfaces are:

- `vessel_current_tab` and the `vessel://tabs/active` resource for the tab currently visible to the human user
- `vessel_read_page` for structured, model-facing page context that includes highlights and annotations

## Memory Tools

- `vessel_memory_note_create`
- `vessel_memory_append`
- `vessel_memory_list`
- `vessel_memory_search`
- `vessel_memory_page_capture`
- `vessel_memory_link_bookmark`

## Bookmark And Folder Tools

- `vessel_bookmark_list`
- `vessel_bookmark_search`
- `vessel_bookmark_open`
- `vessel_bookmark_save`
- `vessel_bookmark_remove`
- `vessel_create_folder`
- `vessel_folder_rename`
- `vessel_folder_remove`

## Page Interaction And Recovery Tools

- `vessel_current_tab`
- `vessel_extract_content`
- `vessel_read_page`
- `vessel_list_highlights`
- `vessel_highlight`
- `vessel_clear_highlights`
- `vessel_scroll`
- `vessel_dismiss_popup`
- `vessel_set_ad_blocking`
- `vessel_wait_for`

## Named Session Tools

- `vessel_save_session`
- `vessel_load_session`
- `vessel_list_sessions`
- `vessel_delete_session`

Session files are sensitive because they may contain login cookies and tokens. Vessel stores them under the app user-data directory with restrictive file permissions.

## Extraction Modes

Notable extraction modes include:

- `visible_only` for currently visible, in-viewport, unobstructed interactive elements plus active overlays
- `results_only` for likely primary search/result links
- `full`, `summary`, `interactives_only`, `forms_only`, and `text_only` for different levels of detail

The extraction output can distinguish:

- active blocking overlays
- dormant consent or modal UI present in the DOM but not active for the current session or region
- saved highlights plus live page annotations that the agent should consider part of the visible context

## MCP Resources

- `vessel://tabs/active`
- `vessel://runtime/state`

## Config Snippets

Generic Codex or TOML-based config:

```toml
[mcp_servers.vessel]
url = "http://127.0.0.1:3100/mcp"
```

Add the same `Authorization: Bearer <token>` header using your client's HTTP-header syntax.

Generic HTTP MCP config:

```json
{
  "mcpServers": {
    "vessel": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "Authorization": "Bearer <token from ~/.config/vessel/mcp-auth.json>"
      }
    }
  }
}
```

Hermes Agent `config.yaml` MCP config:

```yaml
mcp_servers:
  vessel:
    url: "http://127.0.0.1:3100/mcp"
    headers:
      Authorization: "Bearer <token from ~/.config/vessel/mcp-auth.json>"
    timeout: 180
    connect_timeout: 30
```
