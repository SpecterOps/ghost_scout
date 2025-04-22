// lib/dns.js
const dns = require('dns').promises;
const { promisify } = require('util');
const resolveTxt = promisify(dns.resolveTxt);

async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.map(r => `${r.priority} ${r.exchange}`).join(', ');
  } catch (error) {
    console.error(`Error getting MX records for ${domain}:`, error);
    return null;
  }
}

async function getSpfRecord(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    const spfRecord = records.flat().find(record => record.startsWith('v=spf1'));
    return spfRecord || null;
  } catch (error) {
    console.error(`Error getting SPF record for ${domain}:`, error);
    return null;
  }
}

async function getDmarcRecord(domain) {
  try {
    const dmarcDomain = `_dmarc.${domain}`;
    const records = await dns.resolveTxt(dmarcDomain);
    const dmarcRecord = records.flat().find(record => record.startsWith('v=DMARC1'));
    return dmarcRecord || null;
  } catch (error) {
    console.error(`Error getting DMARC record for ${domain}:`, error);
    return null;
  }
}

async function getAllDnsRecords(domain) {
  const [mx, spf, dmarc] = await Promise.all([
    getMxRecords(domain),
    getSpfRecord(domain),
    getDmarcRecord(domain)
  ]);

  return { mx, spf, dmarc };
}

module.exports = {
  getMxRecords,
  getSpfRecord,
  getDmarcRecord,
  getAllDnsRecords
};