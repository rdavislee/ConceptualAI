import { parseArgs } from "jsr:@std/cli/parse-args";
import { init } from "./commands/init.ts";
import { list } from "./commands/list.ts";
import { login } from "./commands/login.ts";
import { install } from "./commands/install.ts";
import { publish } from "./commands/publish.ts";

const args = parseArgs(Deno.args, {
  alias: {
    help: "h",
  },
});

const helpMessage = `
usage: conceptual <command> [options]
commands:
    init
        initialize a new conceptual project
    list
        list installed concepts
    login
        authenticate with the concept registry
    install <USERNAME>/<CONCEPT_NAME>[@<VERSION>]
        install a concept from the hub (username required, version optional)
    publish <CONCEPT_NAME>
        publish a concept to the registry
`;

if (args.help) {
  console.log(helpMessage);
  Deno.exit();
}

const command = args._[0];

if (typeof command !== "string") {
  console.log("Missing command. Use options -h or --help for valid options.");
  Deno.exit(1);
}

switch (command) {
  case "init":
    console.log("Command detected: init");
    await init();
    break;
  case "list":
    await list();
    break;
  case "login":
    await login();
    break;
  case "install": {
    const conceptArg = args._[1];
    if (typeof conceptArg !== "string") {
      console.log("Missing {USERNAME}/{CONCEPT_NAME} for install command.");
      Deno.exit(1);
    }
    await install(conceptArg);
    break;
  }
  case "publish": {
    const conceptName = args._[1];
    if (typeof conceptName !== "string") {
      console.log("Missing CONCEPT_NAME for publish command.");
      Deno.exit(1);
    }
    await publish(conceptName);
    break;
  }
  default:
    console.log(
      "Unknown command. Use options -h or --help for valid options.",
    );
    Deno.exit(1);
}
