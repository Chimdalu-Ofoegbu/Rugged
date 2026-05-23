// Minimal ABIs for the contracts the frontend interacts with.
// Source of truth is contracts/src/*.sol (compiled to contracts/out/*).
// We hand-pick only the functions the browser actually calls so the
// TypeScript types stay narrow + the bundle stays small.

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export const MARKET_ABI = [
  {
    type: "function",
    name: "placeBet",
    inputs: [
      { name: "isYes", type: "bool" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claim",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelBet",
    inputs: [{ name: "isYes", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "yesStake",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "noStake",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "resolved",
    inputs: [],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "yesWon",
    inputs: [],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimed",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

export const MARKET_FACTORY_ABI = [
  {
    type: "function",
    name: "isMarket",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getMarket",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "marketCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;
