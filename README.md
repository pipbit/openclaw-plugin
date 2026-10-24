# Pipbit for OpenClaw

`@pipbit/pipbit` is an OpenClaw channel plugin for Pipbit Connect. It makes
the agent you already run in OpenClaw one of your Pipbit's agents: you add it
by saying one sentence to your Pipbit, and from then on you can talk to it by
voice.

Pipbit is a small voice device. Pip, its built-in assistant, hands you over to
your other agents when you ask for them by name ("connect me to Clementine").
Pipbit Connect is how an agent that runs somewhere else joins that roster: the
agent dials out to Pipbit over a WebSocket (a lasting two-way connection
carried over HTTPS), so your OpenClaw needs no public address, no open port
and no webhook.

## Requirements

- OpenClaw 2026.9.4 or a later 2026.9 release (see [Compatibility](#compatibility)).
- Node 24.16 or later (or 26.1 or later), which OpenClaw itself needs.
- A Pipbit you own, and outbound internet access to `api.pipbit.ai` (HTTPS
  and WebSocket, port 443).

## Install

From ClawHub, in a terminal:

```sh
openclaw plugins install clawhub:@pipbit/pipbit
```

or search for Pipbit on the Plugins page of OpenClaw's Control UI and click
Install. The `clawhub:` prefix matters: a bare `@pipbit/pipbit` is looked up
on npm, where the plugin is not published.

To install from a checkout instead, build it and install the packed tarball:

```sh
npm ci && npm run build && npm pack
openclaw plugins install npm-pack:./pipbit-pipbit-0.1.0.tgz --force
openclaw plugins inspect pipbit --runtime --json
```

`npm pack` rebuilds `dist/` from scratch by itself, and stops with a plain
message when the bundled `ws` is missing, so an empty or out-of-date tarball
cannot slip out.

OpenClaw shows what the plugin declares (the `pipbit` channel, its two tools
and one skill) and asks you to accept it. On OpenClaw 2026.9.4, restart the
Gateway once after installing; later releases pick the plugin up by
themselves.

### Installing on a hosted OpenClaw (for example Hostinger's Docker template)

- Some hosted setups keep a `plugins.allow` list in `openclaw.json`: OpenClaw
  then loads only the plugins named there. If yours has one
  (`openclaw config get plugins.allow` shows it), add `pipbit` to it.
- On OpenClaw 2026.9.4, restart the Gateway after installing. In a Docker
  install, restarting the container does that.
- Keep the tarball somewhere that survives a restart (on Hostinger, under
  `/data`): OpenClaw looks for it again when it updates its plugins.

## Set up

Start setup either way:

- **Control UI**: Channels, then Pipbit, then Set up.
- **Terminal**: `openclaw channels add pipbit` (it needs an interactive
  terminal).

OpenClaw's own chat (saying "connect pipbit" to it) cannot run this setup.
That chat shows a setup's words only when the setup asks a question, and the
pairing waits without asking one, so the sentence would reach you after its
code had expired. Setup stops there at once and points you to the two ways
above.

Setup shows one sentence, for example:

> On your Pipbit, say: "Pip, please add Clementine with code 472 915."

Say it to your Pipbit. Pip adds the agent and, as soon as it is online, hands
you over to it by herself; the agent greets you in its own voice. There is no
code to type and no web page to visit.

- **The name** is the one your OpenClaw agent already has: its configured
  identity name, or else the Name in its workspace's `IDENTITY.md`; with
  neither, it is "OpenClaw". The agent is the one that will answer your
  Pipbit: the account's `agentId` if you set one, else the agent OpenClaw
  sends Pipbit turns to, else the agent you picked when setup asked which
  agent to set up channels for. Pip introduces it as "Clementine from
  OpenClaw". A name kept for Pipbit's own assistant (Pip, Pipbit, Pippa and
  look-alikes) is refused, and setup asks for another one.
- **The code** lasts 10 minutes. If it runs out, terminal setup gets one new
  code by itself, then asks before each further one; the Control UI asks
  before every new code. Pipbit allows 10 new codes per network per hour.
- **Stopping setup** at one of its questions, or stopping the Gateway,
  withdraws the code. A code left behind (a closed terminal) simply runs out;
  nobody can finish a pairing without the setup that started it. In the
  Control UI, Cancel cannot reach the plugin while it waits for your Pipbit
  (an OpenClaw limit), so after cancelling there, do not say the sentence.
  The code runs out by itself within 10 minutes, and until then OpenClaw may
  refuse to start another setup.
- **Already set up?** Running setup again asks before it replaces the saved
  pairing. To pair again, first say "remove Clementine" to your Pipbit, then
  answer yes. Pairing again while the old one is still there would leave two
  agents with the same name on your Pipbit, and Pip could not tell them
  apart. If Pipbit has already turned the saved pairing away, setup goes by
  the reason:
  - The agent is gone from your Pipbit (you said "remove Clementine", it was
    deleted, or Pipbit Connect was switched off for it): setup says so in one
    line and pairs again without asking.
  - Pipbit suspended the agent, or expects it to connect another way: setup
    stops with one line, because pairing again does not help. Contact
    hello@pipworks.ai.
  - The plugin is too old for Pipbit: setup stops with one line. Run
    `openclaw plugins update pipbit` instead.
  - Pipbit refused or replaced the agent's credentials, or turned it away
    for any other reason: the agent may still be on your Pipbit, so setup
    asks first, the same way as above. If this computer's clock is more than
    a minute off, fixing the clock is enough.
- **A lost answer.** If setup says the agent was probably added but its key
  was lost on the way (a dropped connection at the last moment), say "remove
  Clementine" to your Pipbit, then run setup again.

OpenClaw saves the config only when its whole setup is done, and it may ask
a question or two of its own first (for example who may administer OpenClaw
from chat). Pip waits about two minutes for the agent to come online, so as
soon as setup says the agent was added, finish setup straight away: press
Enter through the remaining questions in a terminal, or click through to
Finish in the Control UI (Done saves the settings, but OpenClaw starts the
channel only when the setup dialog closes at Finish). In a terminal, setup
then waits up to two and a half
minutes and shows "Connected to Pipbit." and the agent's first words. Once
the agent is connected, Pip hands you over within a few seconds (a little
longer while she finishes a sentence or while you are talking), so setup
waits at most 50 seconds more for the greeting. On
OpenClaw 2026.9.4, saving the Pipbit settings restarts the whole Gateway, so
the first sign of the agent can take most of a minute; setup waits a full
minute for it before saying the agent connects once the Gateway is running.
If Pip did not hand you over, say "connect me to Clementine" on your Pipbit
(with the OpenClaw Gateway running).

## Status

Apart from "Connecting", which it shows until its first connection after the
Gateway starts, the channel reports one of three words:

| Status | OpenClaw lifecycle | What to do |
|---|---|---|
| Connected | ready | Nothing. |
| Reconnecting | recovering | Usually nothing; the plugin redials by itself (after a network drop, a Pipbit service restart, or another copy of the same agent taking over, which makes it wait about 30 s). But a mistyped Pipbit address (`connectUrl`) or a network that blocks the connection also reads Reconnecting (or Connecting, if it never got through since the Gateway started), and it stays that way with no end and no warning in the status. If it lasts more than a few minutes, the reason is in the Gateway log (`openclaw logs --follow`): lines such as `connect: socket error`, `connect: upgrade timed out` or `pipbit: account default is reconnecting`. |
| Needs attention | blocked | Read the reason and the fix in `openclaw channels status`. Most often the agent was removed from your Pipbit: run setup again. A suspended agent, or one Pipbit expects to connect another way, needs hello@pipworks.ai (once it is sorted out, restart the Gateway so it connects again), and a plugin Pipbit calls too old needs `openclaw plugins update pipbit`; setting up again helps none of these. |

The Control UI's own row labels are fixed by OpenClaw: "Running" whenever
the channel is up, "Configured" while it is stopped, and "Needs attention".
"Running" does not mean connected: it also shows while the plugin is still
trying to get through, including with a mistyped Pipbit address or on a
network that blocks the connection, where it can stay that way for good.
Only `openclaw channels status` tells Connected from Connecting and
Reconnecting, and shows the plugin's detail. While the Gateway is stopped, `openclaw channels status`
and `openclaw status --all` still show a refusal the Gateway saw last, but
plain `openclaw status` only says the channel is configured. Why the link is
reconnecting is in the Gateway log (`pipbit: account default is
reconnecting: ...`).

`openclaw channels status` also lists Gateway settings that keep Pipbit from
working as it should, each with the line to change:

- **Several agents.** When OpenClaw has more than one agent and none is set
  to answer Pipbit, OpenClaw cannot pick one and Pipbit turns go unanswered.
  Name the agent: `openclaw config set channels.pipbit.agentId <agent id>`
  (for a named account, `channels.pipbit.accounts.<account>.agentId`), or
  add a binding for the pipbit channel.
- **A tool list that leaves out `pipbit_handback`.** A sandbox for sessions
  other than the main one (sandbox mode `non-main` or `all`), a `tools.allow`
  list, or an agent's own `tools.allow` list can remove it. The agent then
  cannot hand you back to Pip, and a turn from a voice Pipbit did not
  recognise is answered with no tools at all. Add `"pipbit_handback"` to the
  list the status names, for example `tools.sandbox.tools.alsoAllow` or
  `tools.alsoAllow`.

## Tools

The plugin gives the agent two tools.

- `pipbit_handback` hands the conversation back to Pip after the agent's
  reply. The agent calls it when you are done, say that is all, ask for
  Pip, or want something it cannot help with. It is offered only on turns
  that came from Pipbit, and never on the connect intro (the agent's
  greeting).
- `pipbit_speak` lets the agent speak on your Pipbit without being asked, for
  a reminder or a result it promised you, while the Pipbit link is
  connected. It has no destination: it always speaks to the Pipbit's owner.
  It is off unless you switch it on:

  ```json5
  { channels: { pipbit: { proactiveSpeech: true } } }
  ```

  With the switch on, the agent gets the tool on two kinds of run:

  - your own turns on Pipbit, in your verified voice;
  - runs OpenClaw does not mark as another person's: scheduled jobs,
    heartbeats, and your own chats with the agent when OpenClaw knows they
    are yours (your id is listed in `commands.ownerAllowFrom`, or you use
    the Control UI as an admin). Without that list OpenClaw treats every
    chat sender as someone else, so the tool is not offered in chats.

  It never gets it on a run OpenClaw marks as someone else's (for example a
  message from another person on a chat channel), or on a Pipbit turn
  without your verified voice (a guest, or a voice Pipbit did not
  recognise).

  Under any of OpenClaw's tool profiles (`minimal`, `coding`, `messaging` or
  `full`) no tool list needs changing. With no `tools.profile` set at all,
  also add the tool to `tools.alsoAllow` (`["pipbit_speak"]`); with a
  restrictive `tools.allow` list, add it there.

  With the switch off, the agent cannot reach you on Pipbit later: nothing
  it schedules can speak there, so it should not promise a reminder or a
  report on Pipbit. For reminders on the device, ask Pip.

A greeting is not the end of a conversation, so the agent's connect intro
never offers `pipbit_handback` (a verified intro keeps the agent's other
tools; an unverified one runs with no tools), and a hand-back asked there
is ignored, with a line in the Gateway log. The tool's description tells
the agent when it is for (you say you are done, ask for Pip by name, or
want something it cannot help with, so Pip can route it) and when it is not
(its greeting, or having finished what you asked: you may have a follow-up
or a correction). Pipbit also says why the agent was
engaged, either because you asked for it by name or had Pip connect it, or
because Pip sent it a request without its name, and the plugin passes that
on as one line with the greeting and with the first ordinary turn of each
conversation: in the first case stay until you end it or ask for Pip, in
the second answer and stay available for a correction, since Pip takes the
floor back on her own. An older Pipbit sends no such word, and the agent
then gets no line.

Every reply the agent gives on Pipbit is spoken. The channel tells the model
so on every Pipbit turn (short answers, plain words, no formatting). The
plugin also ships a short skill (`skills/pipbit/SKILL.md`) with more on
speaking, the connect greeting and the two tools. OpenClaw offers skills
only when the agent has its normal tools, including the one that reads
files, so the skill reaches turns in the owner's verified voice and never
the others.

The skill can be switched off in OpenClaw's config by a
`skills.entries.pipbit.enabled: false`. An earlier copy of this plugin let
`openclaw doctor --fix` write that line before the first pairing, and
doctor never removes it, so an install paired with that copy may still have
the skill off. Setup switches the skill back on: a new pairing does it, and
so does a setup run that keeps the saved pairing (it says so in one line,
and the pairing stays as it was). To switch it on without running setup,
run `openclaw config unset skills.entries.pipbit.enabled`, or switch the
Pipbit skill on in the Control UI's Skills page. Neither needs a new
pairing.

## Sessions

Each Pipbit owner gets one OpenClaw session with the agent. Everyone who talks
through that owner's Pipbit shares it (Pipbit identifies the owner, not the
voice), and it is never the agent's main session, so what is said on Pipbit
stays out of your other chats. A paired agent is registered for its owner
alone, so while the Pipbit is in Family Mode ("Multi-user"), which is
anonymous, owner included, nobody reaches it: Pip says the agent is only
for the owner, and the owner turns Family Mode off to use it.

## Voices

Pipbit tries to recognise its owner's voice and says so when it can. A turn
with the owner's verified voice gets the agent's normal tools; any other turn
(a guest, a noisy room, or no verdict at all) gets only `pipbit_handback`.
When Pipbit sends no verdict, no turn counts as the owner's verified voice,
so the agent answers by voice but never gets its tools (with Family Mode on
the agent is not reached at all, see Sessions).
Speaker verification is a user-experience filter, not a
security control, so do not rely on it to protect anything that matters.

## Removing it

- **From your Pipbit**: say "remove Clementine" to your Pipbit. The plugin
  then reads Needs attention and stops dialling. Running setup again adds it
  back (under the same spoken name; its internal name gets a short suffix,
  because the old one stays taken).
- **From OpenClaw**: first say "remove Clementine" to your Pipbit, so Pip
  does not keep offering an agent that can no longer connect. Then run
  `openclaw channels remove --channel pipbit --delete` (add
  `--account <id>` for a named account). It deletes the account's config,
  its secret and its state file. Without `--delete` the command only
  switches the account off and keeps its config. To remove the plugin as
  well, run `openclaw plugins uninstall pipbit`, which also removes any
  `channels.pipbit` config left behind.

## Privacy

- The agent secret Pipbit issues at pairing is saved in the Gateway config at
  `channels.pipbit.accounts.default.secret`: in `openclaw.json` in OpenClaw's
  state directory (`~/.openclaw` by default, or `OPENCLAW_STATE_DIR`), unless
  `OPENCLAW_CONFIG_PATH` points elsewhere. Setup never shows it and the
  plugin never logs it. You can move it to an environment variable
  (`"secret": "${PIPBIT_SECRET}"`) or an OpenClaw SecretRef
  (`{ "source": "env", "provider": "default", "id": "PIPBIT_SECRET" }`, or
  any other SecretRef source OpenClaw supports, such as a file). The plugin
  tells OpenClaw where its secret lives, so `openclaw secrets audit` reports
  a Pipbit secret stored as plain text, and the Gateway resolves a SecretRef
  before the channel starts. A secret that cannot be resolved affects only
  its own account. On the channel's page in the Control UI the secret sits
  under Advanced settings, hidden; setup writes it, so there is no need to
  edit it there.
- The secret itself never travels: the plugin proves it holds it with a
  signature when it connects.
- The plugin logs no pairing code, session token or reply token. It never
  logs a turn's text on purpose, and it removes that text from the error
  messages it logs; a partial quote inside an error from a model provider can
  still appear.
- A small state file per account, `<OpenClaw state dir>/pipbit/<account>.json`,
  holds the link state, the owner's anonymous subject id and the agent's last
  greeting, and nothing secret.

## Compatibility

OpenClaw's plugin API is experimental and changes between releases, so the
plugin declares the range it supports. It is built and type-checked against
OpenClaw 2026.9.6 and supports 2026.9.4 up to, not including, 2026.10.0:
`openclaw.compat.pluginApi` is `>=2026.9.4 <2026.10.0`. OpenClaw refuses to
install or load it outside that range rather than failing at run time. On
2026.9.4, installing a plugin needs one Gateway restart; later releases pick
it up without one. The install hint in `package.json` (`openclaw.install`)
names ClawHub only, on purpose: given an npm package name there, Set up in
the Control UI on 2026.9.4 tries to install the already installed plugin
from npm and never reaches the pairing sentence. Each new OpenClaw release
line needs a re-test and a new plugin release.

## Development

```sh
npm install
npm test            # every test/**/*.test.ts, with Node's built-in runner
npm run typecheck   # tsc over the whole package
npm run build       # dist/, what the published package runs
npm run harness     # the conformance harness (conformance/harness.ts)
```

The tests and the conformance harness play the plugin against the Pipbit
Connect wire contract's spec bundle, which lives in Pipbit's own repository;
they run there, as part of Pipbit's conformance gate.

The dependency tree stays pure JavaScript (`ws` only): OpenClaw installs
plugins with install scripts switched off.

Releases are made by Pipbit and published on ClawHub.
