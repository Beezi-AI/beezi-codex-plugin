---
name: create-ticket
description: Draft and create a Beezi ticket (Task / Bug / Story) in Codex. Use when the user wants to create a ticket, draft a ticket, file a bug, or add a task/story to their board (Jira, Azure DevOps) or Beezi. The drafting workflow itself is served by the Beezi MCP server.
---

# Beezi: Create Ticket

This skill is a launcher. The drafting workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

## Start here

1. Call `get_drafting_instructions` on the `beezi` MCP server.
2. Follow the returned instructions exactly. They orchestrate every other tool.
3. **Never call `create_ticket` until the user has explicitly approved the draft.**

If the user wants to estimate a ticket, check an estimation, answer estimation questions, or start work on an existing ticket, call `get_estimation_instructions` instead — that is a separate workflow with its own rules.

## Tool map

Listed so you know what exists. The instructions you fetch decide when each is called — don't invent a sequence from this table.

| Tool | Purpose |
| --- | --- |
| `get_drafting_instructions` | The drafting workflow. Call first. |
| `get_estimation_instructions` | The estimation / start-work workflow. Call first for those. |
| `list_projects` | Beezi projects the user can create tickets in |
| `resolve_project` | Resolve a project from context, optionally a git remote |
| `list_repositories` | Repositories connected to a chosen project |
| `get_ticket_template` | Enabled fields and generation rules for a project + issue type |
| `create_ticket` | Create the approved ticket |
| `list_directory`, `search_files`, `search_code`, `read_file` | Explore a Beezi-connected repository. These read the repo as Beezi has it connected, which is not necessarily the working tree you are in — prefer your own file tools for the local checkout. |
| `list_my_tickets` | Tickets assigned to the user, by lane |
| `estimate_task`, `get_estimation` | Trigger an estimation and read its result |
| `start_ticket` | Queue a ticket for the Beezi agent |

## When something fails

Stop and tell the user. Do not retry blindly, and do not fall back to writing the ticket yourself — a draft that never reached Beezi is worse than no draft, because the user will assume it was filed.

**Only `beezi_login` is available.** This machine is not linked. That single tool is the sign-in — call it, then retry the drafting call in the same session. The server picks up the new credentials without a restart and re-advertises its tools.

**No `beezi` tools at all, not even `beezi_login`.** The MCP server isn't connected: ask the user to confirm `codex plugin list` shows `beezi` and to start a new Codex thread. If it is connected and only `beezi_login` plus nothing else ever appears after signing in, drafting is switched off for this Beezi deployment and only their Beezi admin can turn it on.

**Authentication error on a linked machine.** The stored credentials were rejected — a link revoked from the portal does this. Call `beezi_login` again to re-link, then retry. There is no separate MCP sign-in to complete: the server authenticates with the same credentials the analytics hooks use.

**`feature_disabled`.** Ticket drafting is turned off for this deployment. Nothing the user can fix themselves — their Beezi admin must enable it.

**`invalid_arguments`.** Your call was malformed. Correct the arguments and retry once, then stop.

**Anything else.** Report the message, plus the `correlationId` if the result carries one, and stop.
