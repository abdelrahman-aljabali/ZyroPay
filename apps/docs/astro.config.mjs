// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";
import showcase from "../../config/showcase.json" with { type: "json" };

/*
 * Public documentation, https://docs.zyropay.online. Static: every page is prerendered and
 * served by Cloudflare Workers static assets (wrangler.jsonc). Search is Starlight's built-in
 * Pagefind index; diagrams are pre-rendered SVGs (scripts/render-diagrams.mjs), so the only
 * client JavaScript is Starlight's own (theme switch, search, table of contents).
 */
const social = showcase.repository.url
  ? [{ icon: /** @type {const} */ ("github"), label: "Source code", href: showcase.repository.url }]
  : [];

export default defineConfig({
  site: "https://docs.zyropay.online",
  output: "static",
  trailingSlash: "always",
  build: { inlineStylesheets: "never", assets: "_assets" },
  devToolbar: { enabled: false },
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [
    starlight({
      title: "ZyroPay Docs",
      description:
        "How ZyroPay lets an AI agent ask to pay, and you decide: MCP, policy, passkeys, x402 and Masumi escrow on Cardano.",
      logo: { src: "./src/assets/zyropay-mark.svg", alt: "ZyroPay" },
      favicon: "/favicon.svg",
      social,
      customCss: ["./src/styles/theme.css"],
      components: {
        Footer: "./src/components/Footer.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      head: [{ tag: "meta", attrs: { name: "robots", content: "noindex, nofollow" } }],
      lastUpdated: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      expressiveCode: { themes: ["github-dark-default", "github-light-default"] },
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true })],
      sidebar: [
        {
          label: "Overview",
          items: [
            { label: "Introduction", link: "/" },
            { label: "Glossary", slug: "overview/glossary" },
          ],
        },
        {
          label: "How it works",
          items: [
            { label: "Reading order", slug: "how-it-works" },
            { label: "1. The agent asks", slug: "how-it-works/agent-asks" },
            { label: "2. Policy decides", slug: "how-it-works/policy" },
            { label: "3. Your passkey signs", slug: "how-it-works/passkey" },
            { label: "4. Paying with x402", slug: "how-it-works/x402" },
            { label: "5. Escrow with Masumi", slug: "how-it-works/escrow" },
            { label: "6. Proof before release", slug: "how-it-works/proof" },
            { label: "7. Delivery receipts", slug: "how-it-works/receipts" },
            { label: "8. Discover and identify", slug: "how-it-works/discover" },
            { label: "9. Agents hiring agents", slug: "how-it-works/sub-hire" },
            { label: "10. Autonomous mode", slug: "how-it-works/autonomous" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Components", slug: "architecture" },
            { label: "Trust boundaries", slug: "architecture/trust-boundaries" },
            { label: "Data flows", slug: "architecture/flows" },
            { label: "Decisions (ADRs)", slug: "architecture/decisions" },
            { label: "Deployment", slug: "architecture/deployment" },
            { label: "Engineering notes", slug: "architecture/engineering-notes" },
            { label: "Allowance contract", slug: "architecture/allowance-contract" },
          ],
        },
        {
          label: "Security and trust",
          items: [
            { label: "Threat model", slug: "security" },
            { label: "Who you trust", slug: "security/trust" },
            { label: "Attack walkthroughs", slug: "security/attacks" },
          ],
        },
        {
          label: "Evidence",
          items: [
            { label: "Live transactions", slug: "evidence" },
            { label: "Live vs tested offline", slug: "evidence/coverage" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "For users", slug: "guides/users" },
            { label: "For agent builders", slug: "guides/agent-builders" },
            { label: "For sellers", slug: "guides/sellers" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "MCP tools", slug: "reference/mcp" },
            { label: "REST and internal API", slug: "reference/rest-api" },
            { label: "Agent policy", slug: "reference/policy" },
            { label: "States and codes", slug: "reference/codes" },
            { label: "Configuration", slug: "reference/configuration" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Deploy runbook", slug: "operations/deploy" },
            { label: "Environments and migrations", slug: "operations/environments" },
            { label: "Local development", slug: "operations/local" },
          ],
        },
        { label: "Limits and roadmap", slug: "limits" },
      ],
    }),
  ],
});
