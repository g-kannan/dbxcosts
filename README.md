# dbxcosts

Static Databricks cost catalogs for AWS, Azure, and Google Cloud. This repository contains three standalone JSON datasets and needs no application build or runtime dependencies.

| Cloud | Dataset |
| --- | --- |
| AWS | [aws-databricks-costs.json](resources/aws-databricks-costs.json) |
| Azure | [azure-databricks-costs.json](resources/azure-databricks-costs.json) |
| GCP | [gcp-databricks-costs.json](resources/gcp-databricks-costs.json) |

## CDN access

### Cloudflare Workers

`wrangler.jsonc` serves only `resources/` as static assets. No build command or application entry point is needed. In Cloudflare Workers Builds, leave the build command empty and keep the deploy command as `npx wrangler deploy`. The configured Worker name is `dbxcosts`; it must match the Worker connected to the repository.

The live CDN is https://dbxcosts.oltpdba.workers.dev. Fetch each cloud's JSON directly:

```text
https://dbxcosts.oltpdba.workers.dev/aws-databricks-costs.json
https://dbxcosts.oltpdba.workers.dev/azure-databricks-costs.json
https://dbxcosts.oltpdba.workers.dev/gcp-databricks-costs.json
```

| Cloud | Live JSON |
| --- | --- |
| AWS | [AWS pricing](https://dbxcosts.oltpdba.workers.dev/aws-databricks-costs.json) |
| Azure | [Azure pricing](https://dbxcosts.oltpdba.workers.dev/azure-databricks-costs.json) |
| GCP | [GCP pricing](https://dbxcosts.oltpdba.workers.dev/gcp-databricks-costs.json) |

```js
const cloud = 'aws'; // 'aws', 'azure', or 'gcp'
const response = await fetch(`https://dbxcosts.oltpdba.workers.dev/${cloud}-databricks-costs.json`);
if (!response.ok) throw new Error(`Pricing request failed: ${response.status}`);
const catalog = await response.json();
const prices = catalog[cloud];
```

JSON responses allow cross-origin browser access and use a five-minute browser cache. Unknown paths return 404. Maintenance snapshots and scripts are outside the deployed assets directory.

Validate locally without publishing:

```powershell
npx wrangler deploy --dry-run
```

### jsDelivr

After these files are pushed to the public GitHub repository, use these jsDelivr URL templates, replacing `<ref>` with a published commit SHA, tag, or branch:

```text
https://cdn.jsdelivr.net/gh/g-kannan/dbxcosts@<ref>/resources/aws-databricks-costs.json
https://cdn.jsdelivr.net/gh/g-kannan/dbxcosts@<ref>/resources/azure-databricks-costs.json
https://cdn.jsdelivr.net/gh/g-kannan/dbxcosts@<ref>/resources/gcp-databricks-costs.json
```

Pin a commit SHA or release tag when consumers need reproducible prices.

```js
const url = `https://cdn.jsdelivr.net/gh/g-kannan/dbxcosts@${ref}/resources/${cloud}-databricks-costs.json`;
const response = await fetch(url); // cloud: "aws", "azure", or "gcp"
if (!response.ok) throw new Error(`Pricing request failed: ${response.status}`);
const catalog = await response.json();
const prices = catalog[cloud];
```

## Data contract

Each file uses `schemaVersion: 1`, `cloud`, `currency`, `units`, pricing references, and a cloud-specific object (`aws`, `azure`, or `gcp`). Each cloud object contains:

- Supported regions and a default region.
- `vmOnDemandHourly[regionId][instanceId]`: USD per VM-hour, using provider-facing instance names. Azure region IDs and instance names are normalized to match its compute catalog.
- `databricks.sqlDbuRates`, `jobsDbuRates`, and `allPurposeDbuRates`: regional USD per DBU-hour rates with `includesCloudInstance` flags.
- Warehouse sizes, worker instance mappings, and job instance specifications with DBU/hour, vCPU, and memory.

Classic compute cost is DBU/hour × DBU rate × runtime hours, plus (driver VM rate + worker count × worker VM rate) × runtime hours. Serverless rates marked `includesCloudInstance: true` already include infrastructure. Warehouse DBU/hour values are aggregate size values; VM costs use the listed driver instance and worker count.

## Provenance and maintenance

VM infrastructure prices are sourced from [Vantage Instances](https://instances.vantage.sh/) through Vantage Instances MCP. The dated MCP responses are retained in [vantage-snapshot.json](maintenance/vantage-snapshot.json) for audit and repeatable updates. Use each cloud's explicit regional VM rates when calculating infrastructure costs.

VM prices were checked against Vantage Instances MCP on 2026-10-09: 102 regional rates matched. Six existing GCP C3 rates could not be retrieved and remain explicitly listed as unresolved in `source.vmPricingReference` and [refresh-report.json](maintenance/refresh-report.json). GCP retains its previous full-refresh date; `checkedOn` records this partial check. AWS and Azure have complete VM refreshes.

Databricks DBU rates and instance DBU/hour values require separate verification against Databricks references. Vantage provides infrastructure pricing, not Databricks charges. The new AWS `i3.xlarge` has Vantage-verified VM rates, 4 vCPUs, and 30.5 GiB RAM; its 1 DBU/hour is an explicitly marked planning assumption derived from the existing `i3.2xlarge` entry.

Rates exclude taxes and reserved-pricing discounts. Preserve the schema or increment `schemaVersion` for breaking changes. Commit the three JSONs together when making a coordinated pricing release.

## Repeatable price refresh

Requires Node.js 20+ for maintenance commands; consumers still only fetch JSON. No npm dependencies are needed.

1. Generate the exact MCP requests from the current region and SKU lists:

   ```powershell
   node scripts/refresh-prices.mjs --requests
   ```

2. In an agent session connected to [Vantage Instances MCP](https://instances-mcp.vantage.sh/), call each listed tool once per region, passing all its SKUs together. Save the unmodified tool results in `maintenance/vantage-snapshot.json`:

   ```json
   {
     "retrievedOn": "YYYY-MM-DD",
     "responses": [
       {
         "cloud": "aws",
         "regionId": "us-east-1",
         "result": { "content": [{ "type": "text", "text": "<full MCP response>" }], "isError": false }
       }
     ]
   }
   ```

   Include all six region responses. Set the actual retrieval date. Azure MCP requests use compact SKU names and Vantage region names; the script maps these back to the provider-facing catalog IDs.

3. Validate before applying:

   ```powershell
   node scripts/refresh-prices.mjs maintenance/vantage-snapshot.json --check
   node scripts/refresh-prices.mjs maintenance/vantage-snapshot.json
   git diff --check
   git diff -- resources
   ```

   The updater reads only the exact Linux on-demand column. Missing, unavailable, duplicate, malformed, or failed responses prevent a normal refresh. All responses are validated before writing any catalogs. If deliberately retaining unavailable old prices, add `--allow-stale`; the output identifies every retained rate and marks that cloud's refresh as partial. This option was used for the initial GCP check. `--check` never writes files.

4. Review the report and DBU prices separately, commit datasets plus snapshot/report, and publish a version tag for CDN consumers. Add new SKUs to both the regional VM tables and compute catalog before generating requests; never infer missing regional VM prices from another SKU.

Reusable agent prompt:

> Refresh this repo's VM prices using Vantage Instances MCP. Run the request generator, execute all listed requests, save the complete dated snapshot, and run the updater in check mode. Resolve unavailable SKUs where possible; report any incomplete refresh. Do not change Databricks DBU prices or silently accept stale rates. Review the JSON diff and retain the snapshot and report for audit.

For a scheduled process, run that same sequence weekly in an MCP-enabled runner and have it open a review PR. Supply the MCP connection through runner secrets, never committed configuration. The repository does not install a scheduled workflow or auto-publish price changes.
