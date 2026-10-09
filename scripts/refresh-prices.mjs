import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clouds = ['aws', 'azure', 'gcp'];
const catalogs = Object.fromEntries(clouds.map(cloud => [cloud, JSON.parse(fs.readFileSync(path.join(root, 'resources', `${cloud}-databricks-costs.json`), 'utf8'))]));
const sku = (cloud, id) => cloud === 'azure' ? id.replace(/^Standard_/, '').replace(/_/g, '').toLowerCase() : id;
const region = (cloud, id) => cloud === 'azure' ? ({ eastus: 'us-east', centralindia: 'central-india' }[id] ?? id) : id;
const tools = { aws: 'get_ec2_region_pricing', azure: 'get_azure_region_pricing', gcp: 'get_gcp_region_pricing' };

if (process.argv.includes('--requests')) {
  console.log(JSON.stringify(clouds.flatMap(cloud => catalogs[cloud][cloud].regions.map(({ id }) => ({
    cloud, regionId: id, tool: tools[cloud], arguments: {
      region: region(cloud, id), instanceTypes: Object.keys(catalogs[cloud][cloud].vmOnDemandHourly[id]).map(id => sku(cloud, id)),
    },
  }))), null, 2));
  process.exit(0);
}

const input = process.argv[2];
if (!input || input.startsWith('--')) throw new Error('Usage: node scripts/refresh-prices.mjs <snapshot.json> [--allow-stale] [--check]');
const snapshot = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.retrievedOn ?? '') || !Array.isArray(snapshot.responses)) throw new Error('Invalid snapshot date or responses');
const report = { retrievedOn: snapshot.retrievedOn, checked: 0, changes: [], unresolved: [] };
for (const cloud of clouds) {
  const data = catalogs[cloud];
  const unresolved = [];
  for (const { id: regionId } of data[cloud].regions) {
    const matches = snapshot.responses.filter(r => r.cloud === cloud && r.regionId === regionId);
    if (matches.length !== 1 || matches[0].result.isError) throw new Error(`Missing, duplicate, or failed response: ${cloud}/${regionId}`);
    const body = matches[0].result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    for (const [id, oldRate] of Object.entries(data[cloud].vmOnDemandHourly[regionId])) {
      const heading = `## ${sku(cloud, id)} (${region(cloud, regionId)})`;
      const sections = body.split(/^## /m).filter(section => `## ${section.split('\n')[0].trim()}` === heading);
      const rows = sections.length === 1 ? sections[0].split('\n').filter(line => /^\| Linux\s*\|/.test(line)) : [];
      const price = rows.length === 1 ? rows[0].split('|')[2].trim().match(/^\$(\d+(?:\.\d+)?)\/hr$/) : null;
      if (!price || !Number.isFinite(Number(price[1])) || Number(price[1]) <= 0) {
        const issue = { cloud, regionId, instanceId: id, retainedRate: oldRate };
        report.unresolved.push(issue);
        unresolved.push(issue);
        continue;
      }
      const rate = Number(Number(price[1]).toPrecision(12));
      report.checked++;
      if (rate !== oldRate) report.changes.push({ cloud, regionId, instanceId: id, before: oldRate, after: rate });
      data[cloud].vmOnDemandHourly[regionId][id] = rate;
    }
  }
  data.source.vmPricingReference = {
    ...data.source.vmPricingReference,
    url: 'https://instances.vantage.sh/',
    method: 'Vantage Instances MCP',
    checkedOn: snapshot.retrievedOn,
    refreshStatus: unresolved.length ? 'partial' : 'complete',
    unresolved,
  };
  if (!unresolved.length) data.source.vmPricingReference.refreshedOn = snapshot.retrievedOn;
}
console.log(JSON.stringify(report, null, 2));
if (report.unresolved.length && !process.argv.includes('--allow-stale')) throw new Error('Incomplete refresh; no files written. Resolve missing rates or explicitly use --allow-stale.');
if (!process.argv.includes('--check')) {
  for (const cloud of clouds) fs.writeFileSync(path.join(root, 'resources', `${cloud}-databricks-costs.json`), JSON.stringify(catalogs[cloud], null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'maintenance', 'refresh-report.json'), JSON.stringify(report, null, 2) + '\n');
}
