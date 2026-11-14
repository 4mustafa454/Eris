# Troubleshooting (errors we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find native binding` / `@livekit/rtc-ffi-bindings-darwin-arm64` on `npm start` | Running Node 26 | Use Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`), then `rm -rf node_modules package-lock.json && npm install` |
| `chert doctor`: `agent "my-agent" did not join a test room` | Agent not running, or name mismatch (hyphen vs underscore) | Start `npm start` in its own terminal; use `my_agent` everywhere |
| Same error after you pressed Ctrl+C twice | Agent was force-killed; doctor ran in the same terminal | Run agent and `chert dev` in separate terminals |
| `chert doctor`: LiveKit rejected key/secret | Truncated or mismatched key/secret/URL | Re-create the LiveKit API key; use the copy buttons; all three from one project |
| `livekit_not_provisioned` from `chert livekit` | Chert-managed LiveKit not enabled for this plan | Use own LiveKit project |
| `OpenAI Realtime API returned an error ... credit_balance_exhausted` | OpenAI balance is $0 | Add credits at platform.openai.com billing; restart `npm start` |
| Call rings forever / "FaceTime unavailable" | Caller not joined to shared line | Text the join code to the line over iMessage first |
| `line_offline`, "Wei Zhang is busy: the Mac behind it is not accepting calls", worker offline | Chert's Mac is offline (Chert-side) | Contact Chert Discord (Anish); retry when dashboard shows Available |
| `Room disconnected while waiting for participant` | Call ended before Chert's bridge joined; usually a line/Mac or `chert dev` not connected problem | Make sure `chert dev` is connected before calling |
| Video call shows default picture | Agent publishes no video track | Call with FaceTime **Audio** |
| Call ends silently ~5 min in | Trial cap: 5 minutes per call | Redial; or upgrade plan |
| `inference process orphaned` / `job process orphaned` | Leftover from a force-quit | Harmless; restart cleanly |
| `MaxListenersExceededWarning` spam | Side effect of repeated OpenAI errors | Fix the root error (usually credits) |
| `git` leaves `.lock` files in a Claude desktop-mounted folder | Deleting is disabled there | Move stale locks aside (`mv .git/HEAD.lock .git/stale-HEAD.lock`) or run git in your own terminal |
| Typing a folder path alone in zsh -> `permission denied` | It's a path, not a command | Use `cd <path>` |
