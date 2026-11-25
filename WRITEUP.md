# Sightline: ask about what's in front of you

**Hiya Voice AI Challenge · Track: Accessibility** (with Real-Time Assistance) · Harshil Patel

## What I built

Sightline is a voice-first visual assistant for blind and low-vision people. You point your phone's camera at
something and have a conversation about it: "What am I holding?", "Read the label", "Just the microwave part",
"Look again". Gemini Live hears you and sees the camera, and answers in short spoken replies that you can interrupt
at any moment. It runs today in Chrome on a Samsung Galaxy S25, with a small Node server that keeps the API key off
the phone.

On top of the conversation are three features:

- **Read label.** It reads a full-resolution photo of the label and returns the exact printed text, kept separate
  from interpretation. Code, not the model, interprets dates, so "use by" and "best before" are never confused and
  years are never invented.
- **Find an object.** A local YOLO detector tracks the item. A stereo beep moves between your ears and speeds up as
  the item nears the centre of the picture.
- **Instruction companion.** "Guide me through these instructions" gives one concrete camera fix if the text is cut
  off ("The bottom is outside the frame. Move the phone slightly back."). It then reads the steps word for word,
  with no merging of microwave and oven methods, and walks you through them at your pace: Next, Repeat, "What does
  pierce mean?", Done, Pause, and "Where were we?".

## Who it's for, and the problem

If you can't see the packet, everyday questions need help: which tin is this, how long in the microwave, is it
"use by" or "best before"? Today you ask someone, use an app that reads the whole page aloud, or listen to a long
scene description. What's missing is a *conversation*. You ask for exactly what you need, follow up on "it", and are
told how to move the camera when it can't see.

## Why voice

- **Hands and eyes are busy:** your hands hold the item and the phone, and your eyes aren't the interface.
- **Mid-task interaction:** you can interrupt the moment you have the answer and ask a natural follow-up, without
  scrubbing through audio. This matters most mid-task, such as halfway through a recipe.

Buttons and typed input remain as fallbacks for noisy kitchens.

## Key design choices

- **The app owns the facts; the model owns the conversation.** Gemini interprets what you mean, but the app owns
  guide progress, date logic and the exact step text. Only your own "Done", checked against your transcribed words,
  marks a step complete. "Next" never does.
- **The key stays on the server and nothing is recorded.** A token gate protects any remote access, and every build
  is scanned for leaked keys.
- **Honest failure.** When the provider is overloaded, Sightline says so and keeps your place. It never makes up an
  answer.

## Status (honest)

- **Automated:** 1,028 unit and integration tests and 11 browser end-to-end tests pass. They use labelled fixture
  (fake) model responses.
- **Real Gemini:** live runs worked, including a full guided walkthrough. They also caught bugs the fakes couldn't
  ([ai.md](ai.md)).
- **On my S25:** I've used the conversation and label reading. Find with earbuds and the instruction companion
  still need proper device testing.
- **Users:** no blind or low-vision person has tried it yet.

## Next, with more time

1. **Test it with blind and low-vision cooks** and tune answer length, camera guidance and walkthrough wording.
2. **Measure it:** latency on the phone, and accuracy on real packaging rather than synthetic images.
3. **Build a native app** with on-device text recognition for instant framing feedback and TalkBack-first
   navigation.
4. **Add cooking timers** to the walkthrough ("start the 3-minute timer").
5. **Later, explore hands-free smart glasses.** This needs supported hardware, SDK access and testing; there is no
   glasses support today.
