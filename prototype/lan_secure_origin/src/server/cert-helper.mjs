import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

export function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

export function ensureCertificates(certsDir) {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

  const caKey = path.join(certsDir, 'ca.key');
  const caCrt = path.join(certsDir, 'ca.crt');
  const serverKey = path.join(certsDir, 'server.key');
  const serverCsr = path.join(certsDir, 'server.csr');
  const serverCrt = path.join(certsDir, 'server.crt');
  const extCnf = path.join(certsDir, 'ext.cnf');

  if (fs.existsSync(caCrt) && fs.existsSync(serverCrt) && fs.existsSync(serverKey)) {
    return { caCrt, serverCrt, serverKey };
  }

  console.log('[Cert] Generating local Root CA and Server Certificate with OpenSSL...');
  const localIps = getLocalIPs();
  const hostname = os.hostname();

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${caKey}" -out "${caCrt}" -days 3650 -subj "/CN=VREconder LAN Root CA/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  }

  let sanList = ['IP.1 = 127.0.0.1', 'DNS.1 = localhost', `DNS.2 = ${hostname}`, `DNS.3 = ${hostname}.local`];
  localIps.forEach((ip, idx) => {
    sanList.push(`IP.${idx + 2} = ${ip}`);
  });

  const extContent = `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
${sanList.join('\n')}
`;
  fs.writeFileSync(extCnf, extContent.trim(), 'utf8');

  execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${serverKey}" -out "${serverCsr}" -subj "/CN=VREconder Server/O=VREconder/OU=Dev"`, { stdio: 'inherit' });
  execSync(`openssl x509 -req -in "${serverCsr}" -CA "${caCrt}" -CAkey "${caKey}" -CAcreateserial -out "${serverCrt}" -days 825 -extfile "${extCnf}"`, { stdio: 'inherit' });

  console.log('[Cert] Certificates generated successfully with SAN:\n' + sanList.join('\n'));
  return { caCrt, serverCrt, serverKey };
}
