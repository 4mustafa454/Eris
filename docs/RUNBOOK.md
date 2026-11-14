# Runbook

## Every new terminal
```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
cd ~/chert-agent/my-agent
node --version   # expect v24.x
```

## Start
1. Terminal 1: `npm start`. Wait for `"registered worker"` with `"agentName":"my_agent"`.
2. Terminal 2: `chert doctor --agent my_agent` (all green, including `agent "my_agent" joined`), then `chert dev --agent my_agent`.
3. When Terminal 2 says `"my_agent" is in a waiting room`, FaceTime **Audio** +13175070563.
4. Healthy call in Terminal 2: `Incoming FaceTime Audio call` -> `Answered in 0.0 s` -> `FaceTime is ready` -> greeting within 10 s.

## Stop
Ctrl+C **once** in each terminal (Terminal 2 releases the line). Wait for `Stopped.`

## After editing agent.mjs
End the call, Ctrl+C `chert dev`, Ctrl+C `npm start`, `npm run check`, then start both again.

## Useful commands
- `chert whoami` - who/which project is signed in
- `chert login` - re-sign in (every 30 days)
- `chert guide fix` - error code reference
- `chert doctor --agent my_agent` - full health check with a real test job
- `npm run check` - syntax check all agent files

## Git
```sh
git status
git add -A && git commit -m "message"
git push
```
`.env.local` is ignored; verify with `git status` that it never appears.
