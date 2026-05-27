const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

function hashApiKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function generateApiKey() {
  const raw = 'onesim_' + crypto.randomBytes(32).toString('hex');
  const prefix = raw.substring(0, 12);
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

async function main() {
  const { raw, prefix, hash } = generateApiKey();
  console.log('RAW KEY (save this):', raw);
  console.log('Prefix:', prefix);
  console.log('Hash:', hash);

  await prisma.businessApiKey.create({
    data: {
      businessId: 'cmovg0cof0003o7pg7g7ydl9x',
      name: 'QA Test Key',
      keyHash: hash,
      keyPrefix: prefix,
    },
  });
  console.log('API key created in DB');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
