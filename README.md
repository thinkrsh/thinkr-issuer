# Thinkr issuer

This server signs the blind vouchers of the credit of Thinkr, for payments on
Robinhood Chain. It is the API of the dashboard at `dash.thinkr.sh/api/issuer`.
It runs apart from the proxy of the chat
([thinkr-proxy](https://github.com/thinkrsh/thinkr-proxy)): the issuer holds
the private key that signs vouchers, and it never sees a chat, a balance, or a
voucher.

The readers are developers and auditors who want to know how a payment turns
into credit, and why the payment does not link to the chats that the credit
pays for.

## How a top-up works

This section lists the steps of one top-up. One voucher is worth $1 of credit.

1. The chat app makes one random message for each voucher and blinds each
   message with the public key of the issuer. The blinded messages go to the
   dashboard.
2. The dashboard asks the issuer for a quote. The quote names the amount to
   pay, the wallet that receives it, and a text that names the SHA-256 of the
   blinded messages.
3. The wallet of the user signs that text, with no gas, and pays the amount.
4. The dashboard sends the claim: the blinded messages, the hash of the
   transaction, and the signature.
5. The issuer verifies the signature and reads the receipt of the transaction
   on the chain. The receipt must show the exact amount, sent from the wallet
   that signed to the wallet of the quote.
6. The issuer answers with one blind signature for each blinded message. The
   chat app removes the blind and keeps the vouchers on the device.
7. The proxy verifies each voucher with the public key of the issuer when the
   app spends it.

The blind signatures follow RSABSSA-SHA384-PSS-Deterministic of RFC 9474. The
issuer signs only blinded messages, so it cannot tell which voucher came from
which payment.

## What the issuer sees

This section states what the issuer learns and what it keeps.

- It learns the wallet, the transaction, and the amount of each payment. The
  chain shows them to anyone anyway.
- It learns the SHA-256 of the blinded messages of each payment. It never sees
  a message without its blind, so it cannot link a payment to a voucher or to a
  balance of the proxy.
- It keeps each claimed transaction with that hash, so that one payment buys
  credit once. A claim of the same payment for the same blinded messages gets
  the same signatures again, for a dashboard that lost the answer.
- It counts the requests of each visitor by a keyed hash of the IP address. The
  hash key is new at each start, and the counts live in memory only.
- The log has one line for each request: the time, the method, the path, the
  status, and the duration. No line holds a wallet or a signature.

## Payment in THKR

This section explains a top-up that the token of Thinkr pays.

- A dollar paid in THKR buys 25% more credit: 5 vouchers cost $4 of THKR.
- The issuer reads the price of THKR each minute: the reserves of its bonding
  curve on Pons V2, and the WETH/USDG pool of Uniswap v3. A quote takes the
  lower price of the newest reading and the mean of the last hour.
- A quote in THKR holds for 15 minutes. The payment must be in a block before
  the quote ends.
- The THKR goes to a wallet of its own. Once the price rises, Thinkr sells only
  enough of it to cover the model cost of the credit it bought, and burns the
  rest. After 30 days with no rise, Thinkr burns all of it.
- To list what to sell and what to burn, run `npm run treasury`. The command
  reads the chain and the issuer, and sends nothing.

## Routes

This section lists the routes of the issuer. Every route lives under `/api`.

| Route                        | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `GET /health`                | Answers `{ "ok": true }`.                                  |
| `GET /issuer/network`        | The chain, the tokens, and the wallets of a top-up.        |
| `POST /issuer/quote`         | What to sign and to pay for these blinded messages.        |
| `POST /issuer/claims`        | A paid top-up, answered with one blind signature for each. |
| `GET /issuer/token/payments` | Every payment in THKR, the oldest first, for the treasury. |

`src/contract.ts` holds the shape of every request and every answer.

## Run the issuer

This section shows how to start the issuer on your own machine. You need
Node.js 22.12 or later.

1. To install the dependencies, run `npm ci`.
2. To set the environment, copy the names in `.env.example` into an env file of
   your own. The issuer stops at startup and names each variable that is
   missing.
3. To start the issuer, run `npm run dev`. It reads `env/local.env` and listens
   on `127.0.0.1:8788`.

| Variable                | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `VOUCHER_KEY_FILE`      | The RSA private key (PEM, 2048 bits) that signs vouchers.              |
| `DATABASE_FILE`         | The SQLite file of the claimed payments, the quotes, and the prices.   |
| `CLIENT_ADDRESS_HEADER` | Optional. The header with the IP address, such as `CF-Connecting-IP`.  |
| `CHAIN_RPC_URL`         | Optional. The RPC of a provider. Unset, the public RPC of the chain.   |
| `TESTNET_PAYERS`        | Optional. The wallets that may top up while payment runs on a testnet. |

## Limits

This section lists what the issuer does not do.

- The issuer cannot prove to a user that it runs this code. The blind
  signatures protect the user without that proof: the issuer never sees the
  messages that it signs.
- The public RPC of the chain limits its requests. Set `CHAIN_RPC_URL` for the
  RPC of a provider.
- Once THKR leaves its bonding curve for a pool of Uniswap v4, payment in THKR
  pauses until the issuer reads the price of that pool.

## Development

This section lists the commands for work on the issuer.

- To run the formatter, the linter, the type checker, and the tests, run
  `npm run check`.
- To build the issuer into `dist/`, run `npm run build`.

## License

The Apache License 2.0. The full text is in `LICENSE`.
