// Screenshot the live game page: tsx tools/gameshot.ts [name]
import { connect } from "../src/browser.js";
const { browser, page } = await connect();
await page.screenshot({ path: `captures/shots/${process.argv[2] ?? "game"}.png` });
await browser.close();
