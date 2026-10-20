---
name: mattermost-review-message
description: Use the mmp MCP for natural-language mm/Mattermost channel or DM messages and lightweight webhook, channel, or global-person CRUD. Resolve people safely through saved identity mappings and remember an approved default channel only within the current Codex task.
---

# Mattermost Manager

Use the `mmp` MCP. Never hard-code or assume a channel name.

## Shared Storage Diagnostics

- Codex and Claude Code are expected to share the same local SQLite data. If saved webhooks, channels, participants, and conventions are all unexpectedly empty, call `storage_info` before asking the user to register them again.
- Report the returned `dataDir` and counts without exposing webhook URLs. Never conclude that data was never registered solely from empty list results.
- If another client or a fresh process sees nonzero counts for the same `dataDir`, explain that the current MCP process is stale and ask the user to reconnect MMP or start a new session before retrying the original request.
- If the returned `dataDir` differs between clients, set `MATTERMOST_MCP_DATA_DIR` to one shared directory in both MCP configurations; do not copy or recreate secrets as a workaround.

## Session Default Channel

- A session means the current Codex task. Do not persist its default channel to SQLite or reuse it in another task.
- Start with no session default. On the first send without an explicit channel, call `channel_list` and show the registered logical channel names before asking which one to use. Ask even when exactly one channel is registered; never select it automatically.
- Only enabled channels are selectable for sending. If the user chooses a disabled channel, ask whether to enable it with `channel_update` before sending.
- Show the exact pending message with the channel choices. Selecting a channel authorizes sending that displayed message there. After a successful send, remember the selected channel as this task's default.
- If no enabled channel is registered, do not discard the pending message:
  1. Call `webhook_list`.
  2. If a webhook exists, explain that a logical channel must be added and ask only for its logical name, webhook choice when there are multiple, and optional Mattermost channel name or URL.
  3. If no webhook exists, explain that a named incoming webhook URL must be registered first, then guide the user to add a logical channel.
  4. Create nothing until the user supplies the required configuration. After creation, ask whether to use the new channel for the pending message and as this task's default.
- Once a session default exists, an explicit send request such as `mm 보내줘` authorizes sending to that channel. Do not ask for the channel or repeat a send-confirmation step. Ask only for message data that cannot be resolved safely.
- If the user explicitly sets a session default channel, remember it without sending a message.
- If the user says `이번에만 <channel>에 mm 보내줘` or otherwise names a channel different from the session default:
  1. Verify the logical channel with `channel_list`.
  2. Send to that channel as requested without changing the current default first.
  3. After a successful send, ask whether to change this task's default to that channel. Keep the old default unless the user agrees.
- If a named channel is not registered, do not guess or silently create it. Ask whether the user wants to register it and request only the missing configuration.

## Review Messages

These review rules override the Direct Messages section whenever the user asks for a review request or review completion, including when the destination is a named person's DM. Never treat a review DM as ordinary direct text.

Classify natural variants such as `리뷰 요청 mm에 보내줘`, `리뷰요청 mm으로 보내줘`, or `리뷰 완료 Mattermost에 보내줘`:

- A review request to **one** person uses convention `review-request` with the `mention` variable.
- A review request to **several** people uses convention `review-request-multi` with the `mentions` variable. Choose this whenever the user says `팀원 모두`, `전원`, `다같이`, `팀채널에`, names more than one person, or asks to tag a whole channel. Do not send several single-reviewer messages instead.
- A completed review uses convention `review-complete`.

Resolve the recipient before composing the message:

- For a single-reviewer request, use the reviewer explicitly selected by the user or recorded on the MR. Never default to the current user.
- For a multi-reviewer request, call `participant_list` with the destination `channel_name` and take every member **except the one with `is_self: true`**. Join their `mention` values with single spaces, in the order returned. Say in the preview how many people were tagged and that you excluded yourself.
- `review-request-multi` is a channel message. It cannot be a DM — `message_send_dm` rejects it, because a message addressed to five people has no single recipient. If the user asks to DM several reviewers, say so and offer the channel instead.
- For a completed review, use the person who requested the review when GitLab or the conversation identifies them. Otherwise use the MR author and say in the preview that the author was used because no distinct requester was available.
- Read the MR/conversation for that person's GitLab username, then call `participant_list` with `gitlab_username`. Use only the returned `mention`; a display name or GitLab username is not a Mattermost mention.
- Call `participant_list` with `self_only: true` when current-user identity is relevant, but never use the self profile as the recipient merely because no requester mapping was found.
- If no exact mapping exists, ask only for the recipient's Mattermost username, register or update the mapping after the user supplies it, and optionally assign the participant to the selected logical channel. Do not guess, transliterate a name, append `님`, or send a placeholder.

Resolve the MR number and Jira key from the current conversation, checked-out branch, and current MR. Do not guess. If a value is unresolved, ask only for the missing value or values and never send placeholders.

The layout comes from the stored convention template, which may span several lines (for example a team template that adds `{{mr_url}}` on its own line). The server enforces the content, not the layout: the text must start with the mention or mentions, and contain the status emoji, `!<MR number>`, `[<Jira key>]`, and the message. The `message` and `mentions` values themselves must each be one line. The default single-line layout is:

`<mention> <status emoji> !<MR number> | [<Jira key>] <short message>`

The mention field holds every reviewer for `review-request-multi`, so the one line begins with all of them: `@a @b @c :merge_please: !194 | [KEY] 리뷰 부탁드립니당.` Use `:merge_please:` for a review request (single or multi) and `:review_complete_shake:` for a completed review. Keep the message natural and concise for the current context. Default to `리뷰 부탁드립니당.` or `리뷰 완료 했습니다.` when no more specific wording is needed. Add code-change summaries or verification details only when explicitly requested.

For a channel review message, call `message_send`. For a review DM, call `message_send_dm` with the resolved participant and `via_channel_name`. In both cases, always pass the matching `convention_name` and these variables; never pass review content through `text`:

- `mention`: includes `@`
- `mr_number`: numeric value without `!`
- `jira_key`: without brackets
- `message`: final short message

For a review DM, the destination override `@username` is routing metadata, not the visible mention. The rendered message body must still begin with the exact `mention` returned by `participant_list`.

If the user asks only to draft or preview, do not send. Treat delivery as complete only when the selected channel's result has `ok: true`; otherwise report the failure without claiming delivery.

Before a requested preview or any confirmation-required send, show the recipient evidence as `GitLab @<id> → Mattermost @<id>` alongside the one-line message. If the mapping points to the saved self profile unexpectedly, stop and ask the user to confirm the requester instead of treating self as the fallback.

## Natural Participant CRUD

The participant directory is global local metadata shared by every logical channel. `channel_members` links a logical channel to a global participant id; an incoming webhook cannot read or modify real Mattermost channel membership.

- Register a person with display name, Mattermost username, optional GitLab username, and optional `is_self`: `participant_create`.
- List all people, a logical channel's directory, the self profile, or an exact display-name/GitLab/Mattermost match: `participant_list`.
- For a natural partial name such as `철수`, call `participant_list` with `name_query`. Strip a conversational trailing `님` before lookup. Do not silently select when multiple rows are returned: show each candidate's display name and Mattermost mention, then ask which person the user means.
- Correct a name, identity mapping, or self marker: `participant_update`.
- Delete a local identity mapping: `participant_delete`.
- Add or remove a saved participant from a logical channel directory: `channel_member_add` or `channel_member_remove`. If the Mattermost username is absent globally, pass `display_name` so `channel_member_add` creates the global person first and then links it.

Store usernames without `@`; use the returned `mention` when composing messages. Only one participant may have `is_self: true`. Treat the self profile as context for distinguishing the current user from the recipient, not as a default addressee. When the user asks for a channel's participants, call `participant_list` with `channel_name` and clearly label the result as the saved local directory rather than a live Mattermost membership list.

## Direct Messages

This section applies to non-review DMs. Review request and review completion DMs must follow the stricter Review Messages section above.

- Resolve the recipient from the global directory. Prefer exact Mattermost or GitLab identifiers; otherwise use `name_query` and apply the ambiguity rule above.
- A person does not need to belong to the selected logical channel to receive a DM. The channel supplies only the saved webhook credentials.
- If no person matches, ask for the display name and Mattermost username, create the global participant, and continue with the pending message. Do not add channel membership unless the user also requests it.
- Select `via_channel_name` using the same session-default rules as channel messages. The webhook must permit destination overrides; report the Mattermost error if it does not.
- Call `message_send_dm` with the selected row's numeric `participant_id`, the via channel, and exactly one of a convention or direct text. Direct text is allowed only for non-review DMs.
- Before a preview or confirmation-required send, show the resolved display name, exact `@mention`, via channel, and message. If lookup returns multiple people, never preview or send until the user chooses one.

## Natural Webhook CRUD

Map ordinary Korean requests directly to these tools without requiring the user to name them:

- Register a named incoming webhook URL: `webhook_create`.
- Show registered webhooks: `webhook_list`.
- Rename a webhook or replace its URL: `webhook_update`.
- Delete an unused webhook: `webhook_delete`.

A webhook URL is secret. Never repeat it in chat or expose it through diagnostics. Ask only for a missing name or URL. Verify create/update/delete results with the redacted `webhook_list`. If deletion is blocked by linked channels, report those channel names and do not cascade-delete them.

## Natural Channel CRUD

Map ordinary Korean requests directly to these tools:

- Register a logical channel linked to a saved webhook: `channel_create`.
- Show one or all logical channels: `channel_list`.
- Rename, enable/disable, move to another webhook, or change Mattermost overrides: `channel_update`.
- Delete a logical channel mapping: `channel_delete`.

For channel creation, resolve the logical name and webhook name. `mattermost_channel` is optional; when the user supplies a Mattermost URL containing `/channels/<value>`, use the final path value. Ask only for required missing fields. Do not send a message merely because channel or webhook configuration changed. Verify mutations with the corresponding list tool.
