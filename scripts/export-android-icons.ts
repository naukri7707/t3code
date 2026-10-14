#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const ADAPTIVE_ARTWORK_FRACTION = 0.7;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const renderArtwork = (source: Uint8Array, size: number, monochrome = false, artworkFraction = 1) =>
  Effect.tryPromise({
    try: async () => {
      const artworkSize = Math.round(size * artworkFraction);
      let artwork = await sharp(source).resize(artworkSize, artworkSize).png().toBuffer();
      if (monochrome) {
        // Android notification and themed icons use alpha, not the RGB artwork.
        const alpha = await sharp(artwork).greyscale().threshold(48).raw().toBuffer();
        artwork = await sharp({
          create: { width: artworkSize, height: artworkSize, channels: 3, background: "white" },
        })
          .joinChannel(alpha, { raw: { width: artworkSize, height: artworkSize, channels: 1 } })
          .png()
          .toBuffer();
      }
      return sharp({ create: { width: size, height: size, channels: 4, background: "#00000000" } })
        .composite([{ input: artwork, gravity: "centre" }])
        .png()
        .toBuffer();
    },
    catch: (cause) => new AndroidIconRenderError({ layer: "artwork", cause }),
  });

const renderBackground = (size: number) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background: "black" } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer: "background", cause }),
  });

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const source = yield* fs.readFile(
    path.join(repositoryRoot, "assets/prod/app-icon.icon/Assets/icon.png"),
  );
  const background = yield* renderBackground(ADAPTIVE_CANVAS);
  const splashBackground = yield* renderBackground(SPLASH_CANVAS);
  const splashForeground = yield* renderArtwork(source, SPLASH_CANVAS);
  const splash = yield* Effect.tryPromise({
    try: () =>
      sharp(splashBackground)
        .composite([{ input: splashForeground }])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer: "splash", cause }),
  });
  const outputs = [
    [
      "android-icon-foreground.png",
      yield* renderArtwork(source, ADAPTIVE_CANVAS, false, ADAPTIVE_ARTWORK_FRACTION),
    ],
    [
      "android-icon-mark.png",
      yield* renderArtwork(source, ADAPTIVE_CANVAS, true, ADAPTIVE_ARTWORK_FRACTION),
    ],
    ["android-notification-icon.png", yield* renderArtwork(source, 96, true)],
    ["android-icon-background-dev.png", background],
    ["android-icon-background-nightly.png", background],
    ["android-splash-icon-dev.png", splash],
    ["android-splash-icon-nightly.png", splash],
    ["android-splash-icon-prod.png", splash],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
