import * as Addresses from "../addresses";
import * as Witnet from "../../..";
import * as Babel from "@babel/core/lib/transform";
import ProtoBuf from "protocol-buffers"

/*
 * THESE ARE THE DIFFERENT STEPS THAT CAN BE USED IN THE COMPILER SCRIPT.
 */
export function tap (x) {
  console.log(x);
  return x
}

export function requestsBanner () {
  console.log(`
Compiling your Witnet requests...
=================================`)
}

export function requestsSucceed () {
  console.log(`
> All requests compiled successfully
`)
}

export function migrationsBanner () {
  console.log(`
Generating automatic migrations for your contracts...
=====================================================`)
}

export function migrationsSucceed () {
  console.log(`
> All migrations written successfully \x1b[33m(please remember to manually customize them if necessary)\x1b[0m.
`)
}

export function fail (error) {
  console.error(`
! \x1b[31mWITNET REQUESTS COMPILATION ERRORS:\x1b[0m
  - ${error.message}`);
  process.exitCode = 1;
  throw error
}

export function readFile (path, fs) {
  return fs.readFileSync(path, "utf8")
}

export function loadSchema (schemaDir, schemaName, fs) {
  return ProtoBuf(readFile(`${schemaDir}${schemaName}.proto`, fs))
}

export function compile (code) {
  return Babel.transformSync(code,
    {
      "plugins": [
        ["@babel/plugin-transform-modules-commonjs", {
          "allowTopLevelThis": true,
        }],
      ],
    }).code
}

export function execute (code, requestName, dirName, vm) {
  const context = vm.createContext({
    module: {},
    exports: {},
    require: (depName) => {
      if (["witnet-requests", "witnet-request", "witnet"].indexOf(depName) >= 0) {
        return Witnet
      } else {
        return require(depName)
      }
    },
  });

  try {
    const request = vm.runInContext(code, context, __dirname);
    console.log(`  - The final type of the sources is \x1b[36m${Witnet.Types.typeFormat(request.lastTypes.retrieve)}\x1b[0m`);
    console.log(`  - The final type of the aggregator is \x1b[36m${Witnet.Types.typeFormat(request.lastTypes.aggregate)}\x1b[0m`);
    console.log(`  - The final type of the tally is \x1b[36m${Witnet.Types.typeFormat(request.lastTypes.tally)}\x1b[0m`);
    return request
  } catch (e) {
    let error = e;
    if (e.message.includes("is not a export function")) {
      error = Error(`\x1b[1m${requestName} has one of these issues:\x1b[0m\n\
    1: \x1b[1mIt is missing the \`export\` statement\x1b[0m\n\
       Adding this line at the end of ${requestName} may help (please replace \`request\` by the name of your request \
object):
      
         export {request as default}

    2: \x1b[1mThe exported object is not an instance of the \`Request\` class\x1b[0m
       Please double-check that ${requestName} contains an instance of the \`Request\` class and it is exported as \
explained in issue 1.
       New instances of the \`Request\` class are created like this:

         const request = new Request()
         
       The Witnet documentation contains a complete tutorial on how to create requests from scratch:
       https://witnet.github.io/documentation/try/my-first-data-request/#write-your-first-witnet-request
    
    (Node.js error was: ${e})`
      )
    } else if (e.message.includes("is not defined")) {
      const missing = e.message.match(/(.*) is not defined/)[1]
      if (Witnet.hasOwnProperty(missing)) {
        error = Error(`\x1b[1m${requestName} is missing an import for the \`${missing}\` module\x1b[0m
    Adding this line at the beginning of ${requestName} may help:
      
         import { ${missing} } from "witnet-requests"
    
    (Node.js error was: ${e})`)
      }
    }
    throw error
  }
}

export function pack (dro) {
  const request = dro.data.data_request;
  const retrieve = request.retrieve.map((branch) => {
    return { ...branch, script: branch.encode() }
  });
  const aggregate = { ...request.aggregate, script: request.aggregate.encode() };
  const tally = { ...request.tally, script: request.tally.encode() };

  return { ...dro.data, data_request: { ...request, retrieve, aggregate, tally } }
}

export function intoProtoBuf (request, schema) {
  return schema.DataRequestOutput.encode(request)
}

export function intoSol (hex, fileName) {
  const contractName = fileName.replace(/\.js/, "");

  return `pragma solidity ^0.5.0;

import "witnet-ethereum-bridge/contracts/Request.sol";

// The bytecode of the ${contractName} request that will be sent to Witnet
contract ${contractName}Request is Request {
  constructor () Request(hex"${hex}") public { }
}
`
}

export function writeSol (sol, fileName, requestContractsDir, fs) {
  const solFileName = fileName.replace(/\.js/, ".sol");
  fs.writeFileSync(`${requestContractsDir}${solFileName}`, sol);
  return fileName
}

export function writeMigrations (contractNames, migrationsDir, fs) {
  const artifacts = contractNames
  .filter(fileName => fileName !== "Migrations.sol")
  .map(fileName => `${fileName[0].toUpperCase()}${fileName.slice(1).replace(".sol", "")}`);

  const stage2 = `// WARNING: DO NOT DELETE THIS FILE
// This file was auto-generated by the Witnet compiler, any manual changes will be overwritten.
const BlockRelay = artifacts.require("BlockRelay")
const WitnetBridgeInterface = artifacts.require("WitnetBridgeInterface")
const CBOR = artifacts.require("CBOR")
const Witnet = artifacts.require("Witnet")

const addresses = ${JSON.stringify(Addresses, null, 2).replace(/(["}])$\n/gm, (m, p1) => `${p1},\n`)}

module.exports = function (deployer, network) {
  if (network in addresses) {
    Witnet.address = addresses[network]["Witnet"]
    WitnetBridgeInterface.address = addresses["rinkeby"]["WitnetBridgeInterface"]
  } else {
    deployer.deploy(BlockRelay).then(() => {
      return deployer.deploy(WitnetBridgeInterface, BlockRelay.address)
    })
    deployer.deploy(CBOR)
    deployer.link(CBOR, Witnet)
    deployer.deploy(Witnet)
  }
}
`;
  fs.writeFileSync(`${migrationsDir}2_witnet_core.js`, stage2);

  const userContractsArgs = readMigrationArgs(migrationsDir, fs);

  const stage3 = `// This file was auto-generated by the Witnet compiler, any manual changes will be overwritten except
// each contracts' constructor arguments (you can freely edit those and the compiler will respect them).
const Witnet = artifacts.require("Witnet")
const WitnetBridgeInterface = artifacts.require("WitnetBridgeInterface")
${artifacts.map(artifact => `const ${artifact} = artifacts.require("${artifact}")`).join("\n")}

module.exports = function (deployer) {
  deployer.link(Witnet, [${artifacts.join(", ")}])
${artifacts.map(artifact => {
    if (artifact in userContractsArgs) {
      const args = userContractsArgs[artifact]
      .split(/[(,)]/).slice(2).reverse().slice(1).reverse().map(x => x.trim()).join(", ");
      console.log(`> ${artifact}: reusing existing constructor arguments (${args})`);
      return userContractsArgs[artifact]
    } else {
      const args = [artifact, ...mockSolidityArgs(readSolidityArgs(artifact))];
      console.log(`> ${artifact} generating default constructor arguments (${args.slice(1).join(", ")})
  \x1b[33mWARNING: the autogenerated argument values may not make sense for the logic of the ${artifact}` +
        " contract's constructor.\n  Please make sure you customize them if needed before actually deploying anything" +
        ".\x1b[0m")
      return `  deployer.deploy(${args.join(", ")})`
    }
  }).join("\n")}
}
`;
  fs.writeFileSync(`${migrationsDir}3_user_contracts.js`, stage3)
}

export function readSolidityArgs (artifact, fs) {
  const content = readFile(`${userContractsDir}${artifact}.sol`, fs);
  const regex = /constructor\s*\(([\w\s,]*)/m;
  return content.match(regex)[1]
}

export function readMigrationArgs (migrationsDir, fs) {
  fs.closeSync(fs.openSync(`${migrationsDir}3_user_contracts.js`, "a"));
  const content = readFile(`${migrationsDir}3_user_contracts.js`, fs);
  const regex = /^\s*deployer\.deploy\([\s\n]*(\w+)[^)]*\)/mg
  return matchAll(regex, content).reduce((acc, match) => ({ ...acc, [match[1]]: match[0] }), {})
}

export function mockSolidityArgs (args) {
  const mocks = {
    "uint": 0,
    "uint8": 0,
    "uint16": 0,
    "uint32": 0,
    "uint64": 0,
    "uint128": 0,
    "uint256": 0,
    "int": 0,
    "int8": 0,
    "int16": 0,
    "int32": 0,
    "int64": 0,
    "int128": 0,
    "int256": 0,
    "string": "\"CHANGEME\"",
    "bytes": "\"DEADC0FFEE\"",
    "address": "\"0x0000000000000000000000000000000000000000\"",
    "bool": false,
  };

  return args.split(",").map(arg => {
    const [type, argName] = arg.trim().split(" ");
    if (type === "address" && argName === "_wbi") {
      return "WitnetBridgeInterface.address"
    } else if (mocks.hasOwnProperty(type)) {
      return mocks[type]
    } else {
      return 0;
    }
  })
}

export function matchAll (regex, string) {
  const matches = [];
  while (true) {
    const match = regex.exec(string);
    if (match === null) break;
    matches.push(match)
  }
  return matches
}