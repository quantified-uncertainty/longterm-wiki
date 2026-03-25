import type { GrantSource } from "../types.ts";
import { source as coefficientGiving } from "./coefficient-giving.ts";
import { source as eaFunds } from "./ea-funds.ts";
import { source as sff } from "./sff.ts";
import { source as ftxFutureFund } from "./ftx-future-fund.ts";
import { source as manifund } from "./manifund.ts";
import { source as givewell } from "./givewell.ts";
import { source as acxGrants } from "./acx-grants.ts";
import { source as gatesFoundation } from "./gates-foundation.ts";
import { source as wellcomeTrust } from "./wellcome-trust.ts";
import { source as fordFoundation } from "./ford-foundation.ts";
import { source as fli } from "./fli.ts";
import { source as aria } from "./aria.ts";
import { source as vipulnaik } from "./vipulnaik.ts";
import { source as foresightPrizes } from "./foresight-prizes.ts";

export const ALL_SOURCES: GrantSource[] = [
  coefficientGiving,
  eaFunds,
  sff,
  ftxFutureFund,
  manifund,
  givewell,
  acxGrants,
  gatesFoundation,
  wellcomeTrust,
  fordFoundation,
  fli,
  aria,
  vipulnaik,
  foresightPrizes,
];

export { coefficientGiving, eaFunds, sff, ftxFutureFund, manifund, givewell, acxGrants, gatesFoundation, wellcomeTrust, fordFoundation, fli, aria, vipulnaik, foresightPrizes };
