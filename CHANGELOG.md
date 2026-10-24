# Changelog

## 0.1.0 (2026-10-24)

The first release: an OpenClaw agent becomes one of your Pipbit's voice
agents over Pipbit Connect.

- **Setup by voice.** Control UI (Channels, then Pipbit, then Set up) or
  `openclaw channels add pipbit`: setup shows one sentence to say to your
  Pipbit, Pip approves it, and the agent's credentials are saved into the
  Gateway config. Right after Pip approves, setup asks the person to finish
  setup straight away, because Pip waits about two minutes to hand them over.
  In a terminal an expired code is replaced once without asking; the Control
  UI asks before every new code. A stopped setup withdraws its code where it
  can, and once a code is live OpenClaw's Back key is switched off (Back at
  "Get a new code?" means No). In a terminal, setup then waits up to two
  and a half minutes for the agent to connect and greet the person, and at
  most 50 seconds for the greeting once the agent is connected. Only
  after a full minute with no sign of the agent does it say the agent
  connects once the Gateway is running, since on OpenClaw 2026.9.4 saving
  the Pipbit settings restarts the whole Gateway.
- **The spoken name** is the name of the OpenClaw agent that will answer
  Pipbit turns, in OpenClaw's own order: its configured identity name, else
  the Name in its workspace's `IDENTITY.md`, else "OpenClaw". The agent is
  the account's `agentId`, else the one OpenClaw routes the Pipbit channel
  to, else the one setup was started for.
- **Setting up again** asks first, and asks the person to say "remove
  <name>" on their Pipbit before answering yes, because pairing again while
  the old agent is still there leaves two agents with the same name. Setup
  pairs again without asking only when Pipbit reported the agent gone from
  the person's Pipbit (removed by voice, deleted, or Pipbit Connect switched
  off for it). When Pipbit suspended the agent or expects it to connect
  another way, setup stops with one line pointing to hello@pipworks.ai; when
  the plugin is too old for Pipbit, it stops with one line pointing to
  `openclaw plugins update pipbit`. When Pipbit refused or replaced the
  agent's credentials, or turned it away for any other reason, setup asks
  the same "remove <name>" question and never pairs again without a yes. A
  pairing whose last answer was lost on the way says the agent is probably
  on the Pipbit and how to remove it. If the code runs out right after a
  poll went unanswered, setup asks Pipbit once more before it makes a new
  code, since the lost answer may have been the pairing itself.
- **OpenClaw's own chat** ("connect pipbit") cannot run the pairing, and
  setup started there stops at once with one line pointing to the Control
  UI or the terminal.
- **Other accounts.** Pairing the default account again keeps named accounts
  on the Pipbit addresses they inherited from the channel's top level.
- **The channel.** One outbound WebSocket per paired agent, with the
  reconnect rules of the Pipbit Connect protocol, version 1. Status reads
  Connected, Reconnecting or Needs attention.
- **Status detail.** Needs attention says what to do for each reason
  (set up again, contact Pipbit about a suspension or about an agent it
  expects to connect another way, or update the plugin),
  and a refusal stays visible in `openclaw channels status` while the
  Gateway is stopped. The same command names Gateway settings that keep
  Pipbit from working: several agents with none set to answer it, or a tool
  list that leaves out `pipbit_handback`.
- **Spoken replies.** A spoken reply never carries OpenClaw's reply prefix
  (`messages.responsePrefix`). OpenClaw's error text and stand-in replies
  are never spoken, citation markers are dropped, and a reply that could
  not be sent while the link was down is sent again once it is back (for
  up to two minutes). When OpenClaw's tool policy leaves a turn with no
  tool at all, the agent still answers, without tools.
- **Silence.** The connect client can tell Pipbit that a deferred turn
  gets no spoken reply on purpose (`pushSilence`: a `reply` frame with
  `silent: true` and no text, Pipbit Connect protocol 1.7.0), so Pip
  neither says the agent is still working on it nor, later, that it never
  answered. Nothing in the plugin sends one yet.
- **Secrets.** The plugin tells OpenClaw where its secret lives, so
  `openclaw secrets audit` reports a Pipbit secret stored as plain text and
  the Gateway resolves a SecretRef from any source before the channel
  starts.
- **Removing it.** `openclaw channels remove --channel pipbit --delete`
  deletes the account's config, secret and state file.
- **Sessions.** One OpenClaw session per Pipbit owner, never the agent's
  main session.
- **Tools.** `pipbit_handback` hands the conversation back to Pip.
  `pipbit_speak` speaks unprompted to the Pipbit's owner and is off unless
  `channels.pipbit.proactiveSpeech` is true. With it on, the agent gets
  `pipbit_speak` on the owner's own Pipbit turns in their verified voice and
  on runs OpenClaw does not mark as another person's (scheduled jobs,
  heartbeats, and the owner's chats where OpenClaw knows the owner through
  `commands.ownerAllowFrom`), and never on a run OpenClaw marks as
  someone else's or on a Pipbit turn without the owner's verified voice.
  Both tools are listed for every OpenClaw tool profile, so under any
  profile no tool list needs changing. Turns without the owner's verified
  voice (including every turn in Family Mode) get only the handback tool (a
  user-experience filter, not a security control).
- **Staying with the person, or handing back.** The connect intro (the
  agent's greeting) never offers `pipbit_handback`: a verified intro keeps
  the agent's other tools, an unverified one runs with no tools at all, and
  a hand-back asked on an intro is ignored with one Gateway log line. The
  tool's description says when it is for (the person says they are done,
  asks for Pip by name, or wants something the agent cannot help with) and
  when it is not (a greeting, a completed request). When Pipbit says why the agent was engaged (the turn's
  `engagement`, Pipbit Connect protocol 1.8.0: `named` when the person asked
  for the agent by name or had Pip connect it, `router` when Pip sent it a
  request without its name), the turn body carries a one-line note with the
  intro and with the first ordinary turn of each conversation: stay until
  they end it or ask for Pip, or answer and stay available for a correction
  because the floor returns to Pip on its own. An older Pipbit sends no kind
  and the body carries no note. Found the first evening the tool reached a
  real OpenClaw agent (2026-10-18): offered one tool and a note about it,
  the agent handed back on every turn, its greeting included.
- **Skill.** `skills/pipbit/SKILL.md` keeps replies short and speakable on
  turns in the owner's verified voice, keeps the handback line short and in
  the agent's own words, says on which runs `pipbit_speak` is there, and
  tells the agent not to promise reminders on Pipbit when it has no
  `pipbit_speak`.
- **Packaging.** `npm pack` and `npm publish` rebuild `dist/` from scratch
  and stop when the bundled `ws` is missing. ClawHub packs with install
  scripts off, so build before publishing there.
- **Compatibility.** Built and type-checked against OpenClaw 2026.9.6;
  installs on 2026.9.4 up to, not including, 2026.10.0. On 2026.9.4 a
  plugin install needs one Gateway restart.
- **Fixed after the first bench (2026-09-25),** on a hosted OpenClaw
  2026.9.6:
  - The Control UI's channel list reads Running while the account is
    connected; it read Configured, because the channel summary did not
    carry OpenClaw's `running` and `connected`. By OpenClaw's rule the row
    also reads Running while the plugin is still trying to get through (a
    mistyped address included); `openclaw channels status` tells them apart.
  - OpenClaw's doctor no longer switches the skill off. The skill no longer
    requires `channels.pipbit`, which does not exist before the first
    pairing: `openclaw doctor --fix` (which some hosts run at every start)
    took that as an unmet requirement and wrote
    `skills.entries.pipbit.enabled: false`, and doctor never switches a
    skill back on. Setup now removes that `false` (and nothing else in the
    entry), since setting Pipbit up is asking for the skill: a new pairing
    does, and so does a setup run that keeps the saved pairing, which says
    so in one line. An install paired before this fix keeps the skill off
    until one of those runs, or until
    `openclaw config unset skills.entries.pipbit.enabled` (or the switch on
    the Control UI's Skills page); no new pairing is needed.
  - In the Control UI, the line shown right after the pairing says to click
    through to Finish, not Done: Done saves the settings, but OpenClaw
    starts the channel (and so connects) only when the setup dialog closes
    at Finish. On the bench the two were 22 seconds apart.
  - The agent secret sits under Advanced settings on the channel's page in
    the Control UI, still hidden. It showed next to the Enabled switch as
    an empty box that invited typing over it or clearing it.
  - Pip now waits about two minutes to hand the person over, so setup's
    lines say so, and a terminal setup waits up to two and a half minutes
    (was a minute and a half) for the agent's greeting. Once the agent is
    connected, the wait ends after at most 50 seconds: Pip hands over
    within seconds of the agent coming online or not at all (for example
    when the Pipbit session has ended), so a longer spinner showed nothing.
  - Set up in the Control UI works on OpenClaw 2026.9.4. There, inside a
    running Gateway, setup offered to install the already installed plugin
    from npm, failed ("Package not found on npm") and went back to "Select
    a channel" before the pairing sentence. The package's install hint now
    names ClawHub only (2026.9.4 goes to npm whenever the hint names an npm
    package; 2026.9.5 and later first check whether the plugin is loaded).
  - `pipbit_handback` is offered on turns without the owner's verified
    voice, and `pipbit_speak` on the runs that should have it (found
    2026-10-18). OpenClaw 2026.9.6 does not build a run's tools from the
    plugin the Gateway loaded: it builds them from a copy of the package
    with a module graph of its own, so the turn the channel had filed for
    the tool factory was never in the copy, the factory offered nothing,
    OpenClaw refused the one-tool run, and every such turn was answered on
    the no-tools retry since the first bench; the speak tool found no
    running account in the copy, so it was never offered. The registry the
    channel and the tools share now lives on the process (`globalThis`),
    which every copy sees. The retry's log line no longer sends you to the
    config: it says OpenClaw offered no `pipbit_handback` tool for the run
    and names what can cause that.
