# Sightline — Hiya Voice AI Challenge submission

**Ask about what's in front of you.**

Sightline lets people ask about what is in front of them and get concise spoken help. We demonstrate it with
ingredient identification and packaging instructions. It runs on a phone today; a future native integration
could bring the interaction to supported smart glasses.

## Audience and problem

Blind and low-vision people constantly meet small, unlabelled-by-touch questions: which tin is this, what does
the back of the packet say, is it "use by" or "best before", how long in the microwave. Existing options are
asking someone, apps that read a whole page of text aloud, or describe a scene in one long monologue. What is
missing is a *conversation*: "What am I holding?" → "Read the label" → "Just the microwave part" → "Repeat that",
with the assistant remembering what "it" is and asking for one useful camera adjustment when it can't see.

## Why voice matters

Hands are busy holding the item and the phone; eyes are not the interface. Voice lets the user ask a specific
question instead of listening to everything, interrupt as soon as they have what they need, and follow up
naturally. Short, interruptible spoken answers respect the user's time; buttons and typed input remain as
dependable alternatives for noisy kitchens.

## What we built

- A mobile web app for Chrome on a Samsung Galaxy S25 that uses the rear camera, microphone and speaker, with a
  Node backend that keeps the Gemini API key server-side and exposes everything on one origin (USB via
  `adb reverse`, or HTTPS tunnel behind an access token).
- Real-time spoken conversation through the Gemini Live API (`gemini-3.8-live`): 16 kHz PCM16 microphone audio
  from an AudioWorklet, camera frames at ≤1 FPS from a latest-frame buffer, 24 kHz audio playback, live
  transcripts, barge-in and a local "Stop speaking" that silences playback instantly and discards late output
  from the cancelled turn.
- A grounded label-reading path: a "Read label" button or a validated `read_label` tool call takes a fresh
  1600 px photo; a Gemini vision call returns structured evidence that separates **exact printed text** (by
  section, with verbatim cooking instructions per method) from the assistant's **interpretation**.
- Deterministic date handling: printed wording and type (use-by vs best-before) are preserved; years are never
  invented; ambiguous day/month orders are reported as ambiguous; batch codes are never treated as dates;
  comparison uses an injected current date in Europe/London.
- Snapshot fallback mode (typed question + fresh photo → vision model → on-screen answer + browser speech) when
  Live is unavailable, clearly labelled.
- An accessible, high-contrast mobile UI: large controls with accessible names, push-to-talk, mute, status that
  never relies on colour alone, two managed live regions so announcements don't flood TalkBack, selectable
  transcript with user-controlled clearing, and a secondary developer panel with models and latency diagnostics.
- An optional, private local YOLO26n detector for image-relative object boxes, behind an interface that can be
  removed without affecting conversation.

## Instruction companion

"Guide me through these instructions" turns a packet or instruction sheet into a conversation. Sightline checks a
fresh photo and asks for one concrete adjustment when the text isn't readable, reads the printed steps verbatim
(keeping microwave and oven methods separate), and walks through them at the user's pace: questions don't lose the
place, "Next" is not "Done", and only the user's own "Done" marks progress. Voice matters most here: hands are busy
with the item, and the user can interrupt, ask what a word means, or ask "Where were we?" without looking at a
screen. The app, not the model, owns progress, so it survives interruptions and brief reconnects.

## Original engineering contribution

We did not train a model. The contribution is the product and systems layer around existing models:
the message contract and turn model that make interruption and stale-output rejection reliable; the evidence
pipeline that keeps verbatim text, interpretation and date logic separate and testable; the tool loop that lets
the voice model request a fresh high-resolution photo from the phone; security defaults (server-held key,
origin checks, loopback-or-token access gate, bounded payloads, secret-free client builds); and the mobile
media lifecycle (rear-camera fallbacks, background pause, end-session teardown with no further transmission).

## Limitations (honest status)

- Automated, integration and desktop-browser tests pass with labelled fixture providers. At the time of writing
  the app had **not yet been run against the live Gemini APIs or on a physical S25** in our build environment;
  [docs/test-results.md](docs/test-results.md) records what was and wasn't verified. Latency has not been measured yet.
- Gemini Live is a preview API; behaviour may change. Echo handling on a phone speaker is unverified (headphones
  or push-to-talk are available).
- Sightline reads labels and describes what it sees; it does not certify freshness, doneness, allergen absence
  or safety, and gives no knife or navigation guidance.
- It has not been evaluated with blind or low-vision participants; that is the most important next step.

## Next steps

1. Live-provider and S25 validation with the manual checklist; measure frame age and question-to-audio latency.
2. Co-design sessions with blind and low-vision cooks; tune brevity, clarifying questions and guidance phrasing.
3. Better small-print capture (torch control, multi-frame selection) and more date formats.
4. **Smart glasses (future work, not implemented):** a native mobile app integrating with supported Meta
   wearables (Meta's developer programme at https://developers.meta.com/wearables/device-access-toolkit/ — terms and
   device support to be confirmed) would need supported hardware, SDK access and
   approval, camera/microphone permissions on the glasses and phone, and on-device testing. Sightline has no
   glasses integration today and is not affiliated with Meta or Ray-Ban.
