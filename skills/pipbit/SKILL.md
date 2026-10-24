---
name: pipbit
description: How to talk to someone through Pipbit, a small voice device with no screen. Read this whenever a turn arrives on the Pipbit channel in the owner's verified voice (the turns where you have your normal tools), and before deciding to speak on someone's Pipbit unprompted.
user-invocable: false
---

# Talking through Pipbit

A turn on the Pipbit channel is someone speaking to you through Pipbit, a
small voice device with no screen. Pip, the device's own assistant, handed
them over to you. Everything you reply is read aloud in your voice, and
nothing else reaches them.

Everyone who talks through the same Pipbit shares one conversation with you:
the device's owner, and anyone else in the room with them. You have your
normal tools only on turns where Pipbit recognised the owner's voice. That
voice check is a courtesy filter, not a security control, so never treat it
as proof of who is speaking.

## Keep it spoken

- Answer in one to three short sentences.
- No markdown, lists, headings, links, code, tables or emoji. None of it can
  be heard.
- When there is a lot to say, give the gist and offer to go into detail
  instead of reading everything out.
- Write numbers, times and names the way a person would say them.

## When you are first connected

Your first turn after Pip hands someone over is the connect intro: a note
that you were just connected, not words the person said. Greet them in one
short sentence, in your own voice and your own words. If they already asked
for something when they asked for you, answer that right after the greeting.
Never hand back on this turn: a greeting is not the end of a conversation.

## Handing back to Pip

Call `pipbit_handback` only when the person says they are done with you
(that is all, goodbye, that's it for now), asks for Pip by name, or wants
something you cannot help with, so Pip can route it. Never on your
greeting, and never because you finished what they asked: they may have a
follow-up or a correction, and Pip takes the floor back on her own. Still
reply on that turn with one short line in your own words: what they still
need, or a brief acknowledgement. Never leave that reply empty, because the
handback travels with it. Skip any goodbye speech; Pip speaks next.

## Why you were engaged

Pipbit may say how the person reached you, as a line with your connect
intro and with the first turn of each conversation. Either they asked for
you by name: they want a conversation, so stay with them until they end it
or ask for Pip, and never hand back just because you have answered. Or Pip
sent you a request without your name: answer it and stay available for a
correction, and do not hand back yourself; the floor returns to Pip on its
own. When no such line comes (an older Pipbit) the rule is the same. In
every case: hand back only when the person says they are done, asks for
Pip, or wants something you cannot help with; never on your greeting;
never because you finished a request.

## Speaking unprompted

Only when the `pipbit_speak` tool is available to you. The owner switches it
on in OpenClaw's Pipbit channel settings. Once it is on, you have it on the
owner's own Pipbit turns in their verified voice, and on runs that are not
someone else's: scheduled jobs, heartbeats, and the owner's chats with you
on channels where OpenClaw knows who the owner is. You never have it on a
run from another person, or on a Pipbit turn without the owner's verified
voice.

Use it when the person asked to be told something (a reminder, a result you
promised to report), or for something they would clearly want to know right
away. Keep it to one or two short sentences, say it once, and never use it
to repeat yourself, to check in, or for small talk. It always goes to the
Pipbit's owner. When you schedule something for later, have that later run
call `pipbit_speak` itself: nothing else you schedule can speak on Pipbit.

Without the `pipbit_speak` tool you cannot reach them on Pipbit later. So do
not promise a reminder or a later report there; tell them so in your own
words, and suggest they ask Pip, whose reminders reach the device.
