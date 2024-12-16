#!/usr/bin/env node

import { program } from "@commander-js/extra-typings";
import { mergePacks } from "./core.js";
import { Config, configValidator } from "./config.js";
import * as fs from "fs";

program
  .argument(
    "[input]",
    "The input directory containing archives in MCADDON format."
  )
  .option(
    "-o, --out <path>",
    "The directory to output the result. It will be created automatically."
  )
  .option("-c, --config <path>", "Path to the config file.", true)
  .action((inputDir, options) => {
    const rawConfig =
      typeof options.config === "string"
        ? (JSON.parse(
            fs.readFileSync(options.config, "utf8")
          ) as Partial<Config>)
        : {};

    if (inputDir) {
      rawConfig.input = { dir: inputDir };
    }

    if (options.out) {
      rawConfig.outDir = options.out;
    }

    const config = configValidator.parse(rawConfig);

    return mergePacks(config);
  });

program.parse();
