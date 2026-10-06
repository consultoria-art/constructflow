// ============ NOTAS FISCAIS (ConstructFlow) ============
// Leitura de NF (XML direto, PDF/foto via IA), lancamento com entrada no estoque,
// vinculo com solicitacao de compra e abatimento no orcamento da obra e/ou na solicitacao.

const fs = require('fs');
const path = require('path');

const AI_MODEL = 'claude-sonnet-4-6';
const ITEM_TYPES = ['material', 'equipamento', 'servico'];

// ---------- Criacao automatica das tabelas (nao precisa rodar SQL manual) ----------
async function ensureSchema(prisma) {
  const stmts = [
    `ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3)`,
    `CREATE TABLE IF NOT EXISTS "Invoice" (
      "id" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "purchaseRequestId" TEXT,
      "number" TEXT,
      "series" TEXT,
      "accessKey" TEXT,
      "supplierName" TEXT,
      "supplierCnpj" TEXT,
      "issueDate" TIMESTAMP(3),
      "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "sourceType" TEXT NOT NULL DEFAULT 'manual',
      "deductFromBudget" BOOLEAN NOT NULL DEFAULT false,
      "deductFromPurchase" BOOLEAN NOT NULL DEFAULT false,
      "documentId" TEXT,
      "notes" TEXT,
      "createdById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE TABLE IF NOT EXISTS "InvoiceItem" (
      "id" TEXT NOT NULL,
      "invoiceId" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "itemType" TEXT NOT NULL DEFAULT 'material',
      "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
      "unit" TEXT,
      "unitValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "materialId" TEXT,
      "movementId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
    )`
  ];
  for (const s of stmts) {
    try { await prisma.$executeRawUnsafe(s); } catch (e) { console.error('Notas Fiscais - preparo do banco:', e.message); }
  }
}

// ---------- Arquivo da tela (notas-fiscais.js) ----------
function serveScript(res) {
  fs.readFile(path.join(__dirname, 'notas-fiscais.js'), (err, data) => {
    if (err) { res.statusCode = 404; return res.end('// notas-fiscais.js nao encontrado'); }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(data);
  });
}

// ---------- Utilitarios ----------
function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).replace(/[^\d,.\-]/g, '');
  if (s.indexOf(',') > -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
  else if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function normKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00Z');
  return isNaN(d) ? null : d;
}

function cleanItem(i) {
  const quantity = num(i.quantity);
  const unitValue = num(i.unitValue);
  let totalValue = num(i.totalValue);
  if (!totalValue && quantity && unitValue) totalValue = quantity * unitValue;
  return {
    description: String(i.description || '').trim().slice(0, 300),
    itemType: ITEM_TYPES.includes(i.itemType) ? i.itemType : 'material',
    quantity,
    unit: i.unit ? String(i.unit).trim().slice(0, 20) : null,
    unitValue: round2(unitValue) || (quantity ? round2(totalValue / quantity) : 0),
    totalValue: round2(totalValue),
    materialId: i.materialId || null
  };
}

function normalizeParsed(p) {
  p = p || {};
  const items = (Array.isArray(p.items) ? p.items : []).map(cleanItem).filter(i => i.description);
  let totalValue = round2(num(p.totalValue));
  if (!totalValue) totalValue = round2(items.reduce((s, i) => s + i.totalValue, 0));
  const date = toDate(p.issueDate);
  return {
    number: p.number ? String(p.number).trim() : '',
    series: p.series ? String(p.series).trim() : '',
    accessKey: String(p.accessKey || '').replace(/\D/g, ''),
    supplierName: p.supplierName ? String(p.supplierName).trim() : '',
    supplierCnpj: String(p.supplierCnpj || '').replace(/\D/g, ''),
    issueDate: date ? date.toISOString().substring(0, 10) : '',
    totalValue,
    items
  };
}

// ---------- Leitura de XML da NF-e (sem IA, dados exatos) ----------
function decodeXml(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

function xmlTag(src, tag) {
  const re = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>');
  const m = String(src || '').match(re);
  return m ? decodeXml(m[1]) : '';
}

function parseNFeXml(xml) {
  if (!/<(?:\w+:)?infNFe[\s>]/.test(xml)) return null;
  const idM = xml.match(/<(?:\w+:)?infNFe[^>]*Id="NFe(\d{44})"/);
  const ide = xmlTag(xml, 'ide');
  const emit = xmlTag(xml, 'emit');
  const total = xmlTag(xml, 'ICMSTot') || xmlTag(xml, 'total');
  const dets = xml.match(/<(?:\w+:)?det\s[^>]*>[\s\S]*?<\/(?:\w+:)?det>/g) || [];
  const items = dets.map(d => {
    const prod = xmlTag(d, 'prod');
    return {
      description: xmlTag(prod, 'xProd'),
      quantity: parseFloat(xmlTag(prod, 'qCom')) || 0,
      unit: xmlTag(prod, 'uCom'),
      unitValue: parseFloat(xmlTag(prod, 'vUnCom')) || 0,
      totalValue: parseFloat(xmlTag(prod, 'vProd')) || 0,
      itemType: 'material'
    };
  });
  return {
    number: xmlTag(ide, 'nNF'),
    series: xmlTag(ide, 'serie'),
    accessKey: idM ? idM[1] : '',
    supplierName: xmlTag(emit, 'xNome'),
    supplierCnpj: xmlTag(emit, 'CNPJ') || xmlTag(emit, 'CPF'),
    issueDate: (xmlTag(ide, 'dhEmi') || xmlTag(ide, 'dEmi')).substring(0, 10),
    totalValue: parseFloat(xmlTag(total, 'vNF')) || 0,
    items
  };
}

// ---------- Leitura por IA (PDF, foto ou XML de nota de servico) ----------
const EXTRACT_PROMPT = 'Extraia os dados desta nota fiscal brasileira (pode ser NF-e, DANFE, NFS-e, cupom ou recibo). '
  + 'Responda SOMENTE com um JSON valido, sem nenhum texto antes ou depois e sem markdown, exatamente neste formato: '
  + '{"number":"","series":"","accessKey":"","supplierName":"","supplierCnpj":"","issueDate":"AAAA-MM-DD","totalValue":0,'
  + '"items":[{"description":"","quantity":0,"unit":"","unitValue":0,"totalValue":0,"itemType":"material"}]}. '
  + 'Regras: numeros com ponto decimal e sem simbolo de moeda; supplierName e supplierCnpj sao do EMITENTE (quem vendeu ou prestou o servico); '
  + 'CNPJ e chave de acesso so com digitos; itemType deve ser "material" para insumos de obra que vao para estoque (cimento, cabos, tubos, conectores, parafusos, pecas), '
  + '"equipamento" para maquinas, ferramentas e equipamentos duraveis, e "servico" para mao de obra, locacao, frete, instalacao e demais servicos. '
  + 'Liste cada item da nota separadamente. Se um campo nao existir, use "" ou 0.';

async function aiExtract(apiKey, input) {
  if (!apiKey) throw new Error('A leitura automatica de PDF e foto precisa da chave da IA (ANTHROPIC_API_KEY) configurada no Railway. Por enquanto, use "Preencher manualmente".');
  const content = [];
  if (input.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.pdf } });
  if (input.image) content.push({ type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.image } });
  if (input.text) content.push({ type: 'text', text: 'Conteudo do arquivo da nota:\n' + input.text });
  content.push({ type: 'text', text: EXTRACT_PROMPT });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 4096, messages: [{ role: 'user', content }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Erro na leitura automatica: ' + ((d.error && d.error.message) || 'tente novamente ou preencha manualmente.'));
  const text = (d.content || []).map(c => c.text || '').join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Nao foi possivel ler esta nota. Confira se a imagem esta legivel ou preencha manualmente.');
  return JSON.parse(text.slice(s, e + 1));
}

// ---------- Saidas descontadas das entradas mais antigas (FIFO) ----------
function fifoConsumption(movements) {
  const byMat = {};
  movements.forEach(m => { (byMat[m.materialId] = byMat[m.materialId] || []).push(m); });
  const consumed = {};
  Object.values(byMat).forEach(list => {
    let saidas = list.filter(m => m.type === 'saida').reduce((s, m) => s + m.quantity, 0);
    list.filter(m => m.type === 'entrada').forEach(e => {
      const take = Math.min(e.quantity, Math.max(0, saidas));
      consumed[e.id] = take;
      saidas -= take;
    });
  });
  return consumed;
}

async function findDuplicate(prisma, organizationId, accessKey, supplierCnpj, number) {
  const or = [];
  if (accessKey) or.push({ accessKey });
  if (supplierCnpj && number) or.push({ supplierCnpj, number });
  if (!or.length) return null;
  return prisma.invoice.findFirst({ where: { organizationId, OR: or } });
}

// ---------- Rotas /api/v1/invoices ----------
async function handle(req, res, user, ctx) {
  const { prisma, sendJSON, parseBody, canSeeFinance, logAudit, ANTHROPIC_API_KEY } = ctx;
  try {
    if (!canSeeFinance(user.role)) return sendJSON(res, 403, { error: 'Somente Administrador ou Coordenador podem lancar e ver notas fiscais.' });
    const urlPath = req.url.split('?')[0];
    const orgId = user.organizationId;

    // Ler a nota (nao grava nada, so devolve os dados para conferencia)
    if (urlPath === '/api/v1/invoices/parse' && req.method === 'POST') {
      const { filename, mimeType, data } = await parseBody(req);
      if (!data) return sendJSON(res, 400, { error: 'Arquivo nao recebido.' });
      const lower = String(filename || '').toLowerCase();
      const mt = String(mimeType || '').toLowerCase();
      let parsed, sourceType;
      if (lower.endsWith('.xml') || mt.indexOf('xml') > -1) {
        sourceType = 'xml';
        const xml = Buffer.from(data, 'base64').toString('utf8');
        parsed = parseNFeXml(xml) || await aiExtract(ANTHROPIC_API_KEY, { text: xml.slice(0, 150000) });
      } else if (lower.endsWith('.pdf') || mt === 'application/pdf') {
        sourceType = 'pdf';
        parsed = await aiExtract(ANTHROPIC_API_KEY, { pdf: data });
      } else if (/^image\/(jpeg|png|gif|webp)$/.test(mt)) {
        sourceType = 'imagem';
        parsed = await aiExtract(ANTHROPIC_API_KEY, { image: data, mediaType: mt });
      } else {
        return sendJSON(res, 400, { error: 'Formato nao suportado. Envie o XML da nota, o PDF (DANFE) ou uma foto em JPG ou PNG.' });
      }
      const clean = normalizeParsed(parsed);
      const dup = await findDuplicate(prisma, orgId, clean.accessKey, clean.supplierCnpj, clean.number);
      return sendJSON(res, 200, { ...clean, sourceType, duplicate: dup ? { id: dup.id, number: dup.number, createdAt: dup.createdAt } : null });
    }

    // Listar notas lancadas, com entrada/usado/saldo de cada item de material
    if (urlPath === '/api/v1/invoices' && req.method === 'GET') {
      const invoices = await prisma.invoice.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
      const ids = invoices.map(i => i.id);
      const items = ids.length ? await prisma.invoiceItem.findMany({ where: { invoiceId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [];
      const projects = await prisma.project.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
      const prIds = [...new Set(invoices.map(i => i.purchaseRequestId).filter(Boolean))];
      const prs = prIds.length ? await prisma.purchaseRequest.findMany({ where: { id: { in: prIds } }, select: { id: true, itemName: true, estimatedValue: true, invoiceValue: true } }) : [];
      const movements = await prisma.stockMovement.findMany({ where: { material: { organizationId: orgId } }, orderBy: { createdAt: 'asc' } });
      const movementIds = new Set(movements.map(m => m.id));
      const consumed = fifoConsumption(movements);
      const materials = await prisma.material.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, unit: true } });
      return sendJSON(res, 200, invoices.map(inv => {
        const proj = projects.find(p => p.id === inv.projectId);
        const pr = prs.find(p => p.id === inv.purchaseRequestId);
        return {
          ...inv,
          projectName: proj ? proj.name : '(obra excluida)',
          purchaseRequest: pr || null,
          items: items.filter(it => it.invoiceId === inv.id).map(it => {
            const hasMovement = it.movementId && movementIds.has(it.movementId);
            const used = hasMovement ? round2(consumed[it.movementId] || 0) : null;
            const mat = materials.find(m => m.id === it.materialId);
            return { ...it, materialName: mat ? mat.name : null, used, remaining: hasMovement ? round2(it.quantity - used) : null };
          })
        };
      }));
    }

    // Lancar a nota conferida
    if (urlPath === '/api/v1/invoices' && req.method === 'POST') {
      const b = await parseBody(req);
      const project = await prisma.project.findFirst({ where: { id: b.projectId, organizationId: orgId } });
      if (!project) return sendJSON(res, 404, { error: 'Selecione a obra que recebe esta nota.' });
      const items = (Array.isArray(b.items) ? b.items : []).map(cleanItem).filter(i => i.description);
      if (!items.length) return sendJSON(res, 400, { error: 'Inclua pelo menos um item com descricao.' });
      let pr = null;
      if (b.purchaseRequestId) {
        pr = await prisma.purchaseRequest.findFirst({ where: { id: b.purchaseRequestId, projectId: project.id } });
        if (!pr) return sendJSON(res, 404, { error: 'A solicitacao de compra escolhida nao pertence a esta obra.' });
      }
      const number = b.number ? String(b.number).trim() : '';
      const supplierName = b.supplierName ? String(b.supplierName).trim() : '';
      const supplierCnpj = String(b.supplierCnpj || '').replace(/\D/g, '');
      const accessKey = String(b.accessKey || '').replace(/\D/g, '');
      const issueDate = toDate(b.issueDate);
      const total = round2(num(b.totalValue) || items.reduce((s, i) => s + i.totalValue, 0));

      if (!b.force) {
        const dup = await findDuplicate(prisma, orgId, accessKey, supplierCnpj, number);
        if (dup) return sendJSON(res, 409, { error: 'Esta nota ja foi lancada em ' + new Date(dup.createdAt).toLocaleDateString('pt-BR') + '.', duplicate: true });
      }

      let documentId = null;
      if (b.file && b.file.data) {
        const doc = await prisma.document.create({ data: { filename: b.file.filename || 'nota-fiscal', mimeType: b.file.mimeType || 'application/octet-stream', data: b.file.data, uploadedBy: user.userId, projectId: project.id } });
        documentId = doc.id;
      }

      const invoice = await prisma.invoice.create({
        data: {
          organizationId: orgId, projectId: project.id, purchaseRequestId: pr ? pr.id : null,
          number: number || null, series: b.series ? String(b.series).trim() : null, accessKey: accessKey || null,
          supplierName: supplierName || null, supplierCnpj: supplierCnpj || null, issueDate,
          totalValue: total, sourceType: ['xml', 'pdf', 'imagem'].includes(b.sourceType) ? b.sourceType : 'manual',
          deductFromBudget: !!b.deductFromBudget, deductFromPurchase: !!(b.deductFromPurchase && pr),
          documentId, notes: b.notes ? String(b.notes) : null, createdById: user.userId
        }
      });

      const label = 'NF ' + (number || 's/n') + (supplierName ? ' - ' + supplierName : '');
      const materials = await prisma.material.findMany({ where: { organizationId: orgId } });
      let stockEntries = 0;
      for (const it of items) {
        let materialId = null, movementId = null;
        if (it.itemType === 'material') {
          materialId = it.materialId && materials.some(m => m.id === it.materialId) ? it.materialId : null;
          if (!materialId) {
            const found = materials.find(m => normKey(m.name) === normKey(it.description));
            if (found) materialId = found.id;
            else {
              const mat = await prisma.material.create({ data: { name: it.description.slice(0, 150), unit: it.unit || 'un', organizationId: orgId } });
              materials.push(mat);
              materialId = mat.id;
            }
          }
          const mv = await prisma.stockMovement.create({ data: { materialId, projectId: project.id, type: 'entrada', quantity: it.quantity || 0, unitValue: it.unitValue || 0, notes: label } });
          movementId = mv.id;
          stockEntries++;
        }
        await prisma.invoiceItem.create({ data: { invoiceId: invoice.id, description: it.description, itemType: it.itemType, quantity: it.quantity, unit: it.unit, unitValue: it.unitValue, totalValue: it.totalValue, materialId, movementId } });
      }

      if (invoice.deductFromBudget) {
        await prisma.project.update({ where: { id: project.id }, data: { spent: round2((project.spent || 0) + total) } });
      }
      if (invoice.deductFromPurchase) {
        const prData = {
          invoiceValue: round2((pr.invoiceValue || 0) + total),
          invoiceNumber: pr.invoiceNumber ? pr.invoiceNumber + ', ' + (number || 's/n') : (number || null),
          invoiceDate: issueDate || new Date()
        };
        if (pr.status === 'approved' || pr.status === 'waiting_delivery') { prData.status = 'delivered'; prData.deliveredAt = new Date(); }
        await prisma.purchaseRequest.update({ where: { id: pr.id }, data: prData });
      }

      logAudit(orgId, { entityType: 'Invoice', entityId: invoice.id, action: 'create', userId: user.userId, userName: user.email, newValue: { numero: number, fornecedor: supplierName, valor: total, obra: project.name, abateuOrcamento: invoice.deductFromBudget, abateuSolicitacao: invoice.deductFromPurchase } });
      return sendJSON(res, 201, { id: invoice.id, stockEntries, total });
    }

    // Excluir lancamento (desfaz estoque e abatimentos)
    const m = urlPath.match(/^\/api\/v1\/invoices\/([^\/]+)$/);
    if (m && req.method === 'DELETE') {
      const inv = await prisma.invoice.findFirst({ where: { id: m[1], organizationId: orgId } });
      if (!inv) return sendJSON(res, 404, { error: 'Nota nao encontrada.' });
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      const mvIds = items.map(i => i.movementId).filter(Boolean);
      if (mvIds.length) await prisma.stockMovement.deleteMany({ where: { id: { in: mvIds } } });
      if (inv.deductFromBudget) {
        const p = await prisma.project.findUnique({ where: { id: inv.projectId } });
        if (p) await prisma.project.update({ where: { id: p.id }, data: { spent: Math.max(0, round2((p.spent || 0) - inv.totalValue)) } });
      }
      if (inv.deductFromPurchase && inv.purchaseRequestId) {
        const pr = await prisma.purchaseRequest.findUnique({ where: { id: inv.purchaseRequestId } });
        if (pr) {
          const v = Math.max(0, round2((pr.invoiceValue || 0) - inv.totalValue));
          await prisma.purchaseRequest.update({ where: { id: pr.id }, data: { invoiceValue: v || null } });
        }
      }
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
      await prisma.invoice.delete({ where: { id: inv.id } });
      if (inv.documentId) await prisma.document.deleteMany({ where: { id: inv.documentId } });
      logAudit(orgId, { entityType: 'Invoice', entityId: inv.id, action: 'delete', userId: user.userId, userName: user.email, previousValue: { numero: inv.number, fornecedor: inv.supplierName, valor: inv.totalValue } });
      return sendJSON(res, 200, { success: true });
    }

    return sendJSON(res, 404, { error: 'Rota nao encontrada' });
  } catch (e) {
    console.error('Notas Fiscais:', e);
    return sendJSON(res, 500, { error: e.message });
  }
}

module.exports = { ensureSchema, serveScript, handle, parseNFeXml, fifoConsumption, normalizeParsed };
