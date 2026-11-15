# Troubleshooting (errors we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find native binding` / `@livekit/rtc-ffi-bindings-darwin-arm64` on `npm start` | Running Node 26 | Use Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`), then `rm -rf node_modules package-lock.json && npm install` |
| `chert doctor`: `agent "eris" did not join a test room` | Agent not running, or name mismatch (hyphen vs underscore) | Start `npm start` in its own terminal; use `eris` (`AGENT_NAME`) everywhere |
| Same error after you pressed Ctrl+C twice | Agent was force-killed; doctor ran in the same terminal | Run agent and `chert dev` in separate terminals |
| `chert doctor`: LiveKit rejected key/secret | Truncated or mismatched key/secret/URL | Re-create the LiveKit API key; use the copy buttons; all three from one project |
| `livekit_not_provisioned` from `chert livekit` | Chert-managed LiveKit not enabled for this plan | Use own LiveKit project |
| Call rings forever / "FaceTime unavailable" | Caller not joined to shared line | Text the join code to the line over iMessage first |
| `line_offline`, "the Mac behind the line is not accepting calls", worker offline | Chert's Mac is offline (Chert-side) | Contact Chert Discord (Anish); retry when dashboard shows Available |
| `Room disconnected while waiting for participant` | Call ended before Chert's bridge joined; usually a line/Mac or `chert dev` not connected problem | Make sure `chert dev` is connected before calling |
| Video call shows the line's default picture | The caller used FaceTime Audio, or the supervisor's camera track failed to publish | Call with FaceTime **Video**; check the supervisor log for the `video` line |
| Call ends silently ~5 min in | Trial cap: 5 minutes per call | Redial; or upgrade plan |
| `inference process orphaned` / `job process orphaned` | Leftover from a force-quit | Harmless; restart cleanly |
