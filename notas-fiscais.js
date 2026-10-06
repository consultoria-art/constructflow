// ============ NOTAS FISCAIS - tela (ConstructFlow) ============
// Carregado pelo index.html. Adiciona o item de menu, a tela e as janelas de lancamento.

let nfInvoices = [];
let nfDraft = null;
let nfPurchaseRequests = [];
let nfMaterials = [];

const NF_TYPE_LABELS = { material: 'Material (estoque)', equipamento: 'Equipamento', servico: 'Servico' };
const NF_SOURCE_LABELS = { xml: 'XML', pdf: 'PDF', imagem: 'Foto', manual: 'Manual' };

// ---------- Monta menu, tela e janelas ----------
(function nfInjectUI() {
  const comprasNav = document.querySelector('.sidebar nav a[data-view="compras"]');
  if (comprasNav) comprasNav.insertAdjacentHTML('afterend', '<a data-view="notas" onclick="showView(\'notas\')"><span>🧾</span> Notas Fiscais</a>');

  const main = document.querySelector('.main');
  if (main) main.insertAdjacentHTML('beforeend', ''
    + '<div class="view-section" id="view-notas">'
    + '<div class="header"><div><h1>Notas Fiscais</h1><p>Entradas de materiais, equipamentos e servicos vinculadas a cada nota</p></div>'
    + '<div class="header-right"><button class="btn btn-primary" onclick="nfOpenModal()">+ Lancar Nota Fiscal</button></div></div>'
    + '<div class="hint-box">💡 Anexe o XML, o PDF ou uma foto da nota: a plataforma le os dados, voce confere e salva. Materiais entram no estoque ligados a nota, e voce escolhe se o valor abate do orcamento da obra, da solicitacao de compra ou dos dois.</div>'
    + '<div id="nfSummary"></div>'
    + '<div class="card"><div id="nfTable"><div class="loading">Carregando...</div></div></div>'
    + '</div>');

  document.body.insertAdjacentHTML('beforeend', ''
    // Janela de lancamento
    + '<div class="modal-overlay" id="nfModal"><div class="modal-box" style="width:860px;max-width:96%;">'
    + '<h2 style="margin-bottom:6px;">Lancar Nota Fiscal</h2>'
    + '<p style="font-size:12px;color:#6b7280;margin-bottom:16px;">XML da NF-e e lido com os dados exatos. PDF e foto sao lidos pela IA: confira os valores antes de salvar.</p>'
    + '<div class="error" id="nfError" style="color:#dc2626;font-size:13px;margin-bottom:12px;display:none;"></div>'
    + '<label class="field">Obra que recebe esta nota</label>'
    + '<select id="nfProject" class="input" onchange="nfOnProjectChange()"></select>'
    + '<div id="nfStepUpload">'
    + '<label class="field">Arquivo da nota (XML, PDF ou foto JPG/PNG, ate 4MB)</label>'
    + '<input type="file" id="nfFile" class="input" accept=".xml,.pdf,image/jpeg,image/png,image/webp">'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
    + '<button class="btn btn-primary" id="nfReadBtn" onclick="nfReadFile()">Ler nota</button>'
    + '<button class="btn btn-secondary" onclick="nfStartManual()">Preencher manualmente</button>'
    + '</div>'
    + '<div class="loader" id="nfReadLoader" style="display:none;font-size:13px;color:#6b7280;margin-top:10px;">Lendo a nota, isso pode levar alguns segundos...</div>'
    + '</div>'
    + '<div id="nfReview" class="hidden"></div>'
    + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:20px;">'
    + '<button class="btn btn-secondary" onclick="closeModal(\'nfModal\')">Cancelar</button>'
    + '<button class="btn btn-primary hidden" id="nfSaveBtn" onclick="nfSave()">Salvar nota</button>'
    + '</div></div></div>'
    // Janela de detalhes
    + '<div class="modal-overlay" id="nfDetailModal"><div class="modal-box" style="width:820px;max-width:96%;">'
    + '<h2 style="margin-bottom:6px;" id="nfDetailTitle">Nota</h2>'
    + '<p id="nfDetailMeta" style="font-size:12px;color:#6b7280;margin-bottom:16px;"></p>'
    + '<div id="nfDetailBody"></div>'
    + '<div style="display:flex;gap:12px;justify-content:space-between;margin-top:20px;">'
    + '<button class="btn btn-danger" id="nfDeleteBtn">Excluir lancamento</button>'
    + '<div style="display:flex;gap:12px;"><button class="btn btn-secondary hidden" id="nfDownloadBtn">Baixar arquivo da nota</button>'
    + '<button class="btn btn-secondary" onclick="closeModal(\'nfDetailModal\')">Fechar</button></div>'
    + '</div></div></div>');
})();

// ---------- Integracao com a navegacao e as permissoes existentes ----------
const _nfOrigShowView = showView;
showView = function (view) {
  _nfOrigShowView(view);
  if (view === 'notas') loadNotasView();
};

const _nfOrigApplyRolePermissions = applyRolePermissions;
applyRolePermissions = function () {
  _nfOrigApplyRolePermissions();
  const nav = document.querySelector('.sidebar nav a[data-view="notas"]');
  if (nav) nav.classList.toggle('hidden', !canSeeFinanceUI());
};

// ---------- Lista ----------
async function loadNotasView() {
  const c = document.getElementById('nfTable');
  c.innerHTML = '<div class="loading">Carregando...</div>';
  try {
    const res = await fetch(API + '/api/v1/invoices', { headers: apiHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Erro ao carregar');
    nfInvoices = d;
    const total = nfInvoices.reduce((s, i) => s + (i.totalValue || 0), 0);
    document.getElementById('nfSummary').innerHTML = nfInvoices.length
      ? '<p style="font-size:13px;color:#374151;margin-bottom:12px;">' + nfInvoices.length + ' nota(s) lancada(s), somando <strong>' + fmtMoney(total) + '</strong>.</p>'
      : '';
    if (!nfInvoices.length) {
      c.innerHTML = '<div class="loading">Nenhuma nota lancada ainda. Clique em "+ Lancar Nota Fiscal" para comecar.</div>';
      return;
    }
    let h = '<table class="table-projects"><thead><tr><th>Emissao</th><th>Numero</th><th>Fornecedor</th><th>Obra</th><th>Valor</th><th>Vinculo</th><th>Abatido de</th></tr></thead><tbody>';
    nfInvoices.forEach(inv => {
      const vinculo = inv.purchaseRequest ? esc(inv.purchaseRequest.itemName) : '<span style="color:#6b7280;">Compra direta</span>';
      const abat = [];
      if (inv.deductFromBudget) abat.push('<span class="status-badge" style="background:#dbeafe;color:#1e40af;">Orcamento</span>');
      if (inv.deductFromPurchase) abat.push('<span class="status-badge" style="background:#dcfce7;color:#166534;">Solicitacao</span>');
      h += '<tr style="cursor:pointer;" onclick="nfOpenDetail(\'' + inv.id + '\')">'
        + '<td>' + fmtDate(inv.issueDate || inv.createdAt) + '</td>'
        + '<td><strong>' + esc(inv.number || 's/n') + '</strong></td>'
        + '<td>' + esc(inv.supplierName || '-') + '</td>'
        + '<td>' + esc(inv.projectName) + '</td>'
        + '<td>' + fmtMoney(inv.totalValue) + '</td>'
        + '<td>' + vinculo + '</td>'
        + '<td>' + (abat.join(' ') || '<span style="color:#6b7280;">Nao abatido</span>') + '</td></tr>';
    });
    h += '</tbody></table>';
    c.innerHTML = h;
  } catch (e) { c.innerHTML = '<div class="loading">Erro ao carregar: ' + esc(e.message) + '</div>'; }
}

// ---------- Detalhes ----------
function nfOpenDetail(id) {
  const inv = nfInvoices.find(x => x.id === id);
  if (!inv) return;
  document.getElementById('nfDetailTitle').textContent = 'NF ' + (inv.number || 's/n') + (inv.supplierName ? ' - ' + inv.supplierName : '');
  const meta = [];
  if (inv.supplierCnpj) meta.push('CNPJ ' + esc(inv.supplierCnpj));
  meta.push('Obra: ' + esc(inv.projectName));
  meta.push('Emitida em ' + fmtDate(inv.issueDate));
  meta.push('Lancada em ' + fmtDate(inv.createdAt) + ' via ' + (NF_SOURCE_LABELS[inv.sourceType] || inv.sourceType));
  document.getElementById('nfDetailMeta').innerHTML = meta.join(' &middot; ');

  let h = '<table class="table-projects"><thead><tr><th>Item</th><th>Tipo</th><th>Qtde</th><th>Valor</th><th>Entrou</th><th>Usado na obra</th><th>Saldo</th></tr></thead><tbody>';
  inv.items.forEach(it => {
    const isMat = it.itemType === 'material';
    const unit = it.unit ? ' ' + esc(it.unit) : '';
    const saldoColor = it.remaining !== null && it.remaining <= 0 ? '#991b1b' : '#065f46';
    h += '<tr><td>' + esc(it.description) + (it.materialName && it.materialName !== it.description ? '<div style="font-size:11px;color:#6b7280;">Estoque: ' + esc(it.materialName) + '</div>' : '') + '</td>'
      + '<td>' + (NF_TYPE_LABELS[it.itemType] || it.itemType) + '</td>'
      + '<td>' + it.quantity + unit + '</td>'
      + '<td>' + fmtMoney(it.totalValue) + '</td>'
      + '<td>' + (isMat ? (it.used === null ? '<span style="color:#9a3412;">entrada excluida</span>' : it.quantity + unit) : '-') + '</td>'
      + '<td>' + (isMat && it.used !== null ? it.used + unit : '-') + '</td>'
      + '<td style="font-weight:600;color:' + saldoColor + ';">' + (isMat && it.remaining !== null ? it.remaining + unit : '-') + '</td></tr>';
  });
  h += '</tbody></table>';
  h += '<p style="font-size:13px;margin-top:12px;"><strong>Total da nota:</strong> ' + fmtMoney(inv.totalValue) + '</p>';
  if (inv.purchaseRequest) {
    const pr = inv.purchaseRequest;
    const saldo = (pr.estimatedValue || 0) - (pr.invoiceValue || 0);
    h += '<p style="font-size:13px;margin-top:6px;"><strong>Solicitacao:</strong> ' + esc(pr.itemName) + ' &middot; aprovado ' + fmtMoney(pr.estimatedValue) + ' &middot; total em notas ' + fmtMoney(pr.invoiceValue || 0)
      + ' &middot; <span style="color:' + (saldo < 0 ? '#991b1b' : '#065f46') + ';font-weight:600;">saldo ' + fmtMoney(saldo) + '</span></p>';
  }
  h += '<p style="font-size:12px;color:#6b7280;margin-top:10px;">As saidas de material registradas em Suprimentos sao descontadas das entradas mais antigas primeiro.</p>';
  document.getElementById('nfDetailBody').innerHTML = h;

  const dl = document.getElementById('nfDownloadBtn');
  dl.classList.toggle('hidden', !inv.documentId);
  dl.onclick = () => downloadTaskAttachment(inv.documentId);
  document.getElementById('nfDeleteBtn').onclick = () => nfDelete(inv.id);
  document.getElementById('nfDetailModal').style.display = 'flex';
}

async function nfDelete(id) {
  if (!confirm('Excluir este lancamento? As entradas de material desta nota saem do estoque e os valores abatidos voltam para o orcamento e para a solicitacao.')) return;
  try {
    const res = await fetch(API + '/api/v1/invoices/' + id, { method: 'DELETE', headers: apiHeaders() });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    closeModal('nfDetailModal');
    loadNotasView();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---------- Lancamento: passo 1 ----------
async function nfOpenModal() {
  try {
    const [projRes, prRes, matRes] = await Promise.all([
      fetch(API + '/api/v1/projects', { headers: apiHeaders() }),
      fetch(API + '/api/v1/purchase-requests', { headers: apiHeaders() }),
      fetch(API + '/api/v1/materials', { headers: apiHeaders() })
    ]);
    cachedProjects = await projRes.json();
    nfPurchaseRequests = await prRes.json();
    nfMaterials = await matRes.json();
  } catch (e) { alert('Erro ao carregar dados. Tente novamente.'); return; }
  if (!cachedProjects.length) { alert('Cadastre uma obra em Projetos antes de lancar notas.'); return; }
  nfDraft = null;
  document.getElementById('nfProject').innerHTML = cachedProjects.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
  document.getElementById('nfFile').value = '';
  document.getElementById('nfStepUpload').classList.remove('hidden');
  document.getElementById('nfReview').classList.add('hidden');
  document.getElementById('nfReview').innerHTML = '';
  document.getElementById('nfSaveBtn').classList.add('hidden');
  document.getElementById('nfReadLoader').style.display = 'none';
  nfShowError('');
  document.getElementById('nfModal').style.display = 'flex';
}

function nfShowError(msg) {
  const el = document.getElementById('nfError');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function nfReadFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Nao foi possivel abrir o arquivo.'));
    reader.readAsDataURL(file);
  });
}

function nfEmptyDraft() {
  return { file: null, sourceType: 'manual', number: '', series: '', accessKey: '', supplierName: '', supplierCnpj: '', issueDate: '', totalValue: 0, items: [], duplicate: null, purchaseRequestId: '', deductFromBudget: true, deductFromPurchase: false };
}

async function nfReadFile() {
  const file = document.getElementById('nfFile').files[0];
  if (!file) { nfShowError('Escolha o arquivo da nota primeiro.'); return; }
  if (file.size > 4 * 1024 * 1024) { nfShowError('O arquivo tem mais de 4MB. Envie uma versao menor ou tire uma nova foto.'); return; }
  nfShowError('');
  const btn = document.getElementById('nfReadBtn');
  btn.disabled = true;
  document.getElementById('nfReadLoader').style.display = 'block';
  let data;
  try {
    data = await nfReadFileAsBase64(file);
    const mimeType = file.type || (file.name.toLowerCase().endsWith('.xml') ? 'text/xml' : '');
    const res = await fetch(API + '/api/v1/invoices/parse', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ filename: file.name, mimeType, data }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Nao foi possivel ler a nota.');
    nfDraft = Object.assign(nfEmptyDraft(), d, { file: { filename: file.name, mimeType: mimeType || 'application/octet-stream', data } });
    if (!nfDraft.items.length) nfDraft.items.push(nfNewItem());
    nfAutoMatchMaterials();
    nfRenderReview();
  } catch (e) {
    nfShowError(e.message + ' Voce pode preencher manualmente: o arquivo continua anexado.');
    nfDraft = nfEmptyDraft();
    if (data) nfDraft.file = { filename: file.name, mimeType: file.type || 'application/octet-stream', data };
    nfDraft.items.push(nfNewItem());
    nfRenderReview();
  }
  btn.disabled = false;
  document.getElementById('nfReadLoader').style.display = 'none';
}

async function nfStartManual() {
  nfShowError('');
  nfDraft = nfEmptyDraft();
  const file = document.getElementById('nfFile').files[0];
  if (file && file.size <= 4 * 1024 * 1024) {
    try { nfDraft.file = { filename: file.name, mimeType: file.type || 'application/octet-stream', data: await nfReadFileAsBase64(file) }; } catch (e) { /* segue sem arquivo */ }
  }
  nfDraft.items.push(nfNewItem());
  nfRenderReview();
}

function nfNewItem() {
  return { description: '', itemType: 'material', quantity: 1, unit: 'un', unitValue: 0, totalValue: 0, materialId: '' };
}

function nfAutoMatchMaterials() {
  nfDraft.items.forEach(it => {
    if (it.itemType !== 'material' || it.materialId) return;
    const key = normKey(it.description);
    const found = nfMaterials.find(m => normKey(m.name) === key);
    it.materialId = found ? found.id : '';
  });
}

// ---------- Lancamento: passo 2 (conferencia) ----------
function nfRenderReview() {
  document.getElementById('nfStepUpload').classList.add('hidden');
  const wrap = document.getElementById('nfReview');
  wrap.classList.remove('hidden');
  const d = nfDraft;
  let h = '';
  if (d.file) h += '<p style="font-size:12px;color:#374151;margin-bottom:10px;">📎 ' + esc(d.file.filename) + (d.sourceType !== 'manual' ? ' &middot; lido via ' + NF_SOURCE_LABELS[d.sourceType] : '') + '</p>';
  if (d.duplicate) h += '<div class="hint-box" style="background:#fef9c3;border-color:#fde68a;color:#854d0e;">⚠️ Esta nota parece ja ter sido lancada em ' + fmtDate(d.duplicate.createdAt) + '. Confira antes de salvar para nao duplicar estoque e valores.</div>';

  h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0 12px;">'
    + nfField('Numero da nota', 'number', 'text')
    + nfField('Serie', 'series', 'text')
    + nfField('Data de emissao', 'issueDate', 'date')
    + '<div style="grid-column:span 2;">' + nfField('Fornecedor', 'supplierName', 'text') + '</div>'
    + nfField('CNPJ do fornecedor', 'supplierCnpj', 'text')
    + '</div>';

  h += '<h3 style="font-size:14px;margin:8px 0;">Itens da nota</h3>'
    + '<div style="overflow-x:auto;"><div id="nfItems"></div></div>'
    + '<button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="nfAddItem()">+ Adicionar item</button>';

  h += '<div style="display:flex;gap:16px;align-items:flex-end;margin-top:16px;flex-wrap:wrap;">'
    + '<div style="width:220px;"><label class="field">Valor total da nota (R$)</label><input class="input" type="number" step="any" value="' + (d.totalValue || 0) + '" oninput="nfDraft.totalValue=parseFloat(this.value)||0;nfUpdateTotals()" style="margin-bottom:0;"></div>'
    + '<div id="nfTotalsCheck" style="font-size:12px;padding-bottom:10px;"></div>'
    + '</div>';

  h += '<div style="background:#f9fafb;border-radius:8px;padding:14px;margin-top:16px;">'
    + '<h3 style="font-size:14px;margin-bottom:8px;">Vinculo e abatimento</h3>'
    + '<label class="field">Solicitacao de compra</label>'
    + '<select id="nfPrSelect" class="input" onchange="nfOnPrChange(this.value)"></select>'
    + '<label class="field" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="nfDeductBudget" style="width:auto;margin:0;"' + (d.deductFromBudget ? ' checked' : '') + ' onchange="nfDraft.deductFromBudget=this.checked"> Abater do orcamento da obra (soma no gasto da obra)</label>'
    + '<label class="field" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="nfDeductPurchase" style="width:auto;margin:0;" onchange="nfDraft.deductFromPurchase=this.checked;nfUpdateTotals()"> Abater do valor aprovado na solicitacao</label>'
    + '<div id="nfPrPreview" style="font-size:12px;color:#374151;margin-top:6px;"></div>'
    + '</div>';

  wrap.innerHTML = h;
  nfRenderItems();
  nfRenderPrSelect();
  document.getElementById('nfSaveBtn').classList.remove('hidden');
}

function nfField(label, key, type) {
  return '<div><label class="field">' + label + '</label><input class="input" type="' + type + '" value="' + esc(nfDraft[key] || '') + '" oninput="nfDraft[\'' + key + '\']=this.value"></div>';
}

function nfRenderItems() {
  const c = document.getElementById('nfItems');
  const inputStyle = 'width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;';
  let h = '<table class="table-projects" style="min-width:760px;"><thead><tr><th style="width:30%;">Descricao</th><th>Tipo</th><th style="width:80px;">Qtde</th><th style="width:60px;">Unid.</th><th style="width:100px;">Valor unit.</th><th style="width:110px;">Total</th><th></th></tr></thead><tbody>';
  nfDraft.items.forEach((it, idx) => {
    const typeOptions = Object.entries(NF_TYPE_LABELS).map(([k, l]) => '<option value="' + k + '"' + (it.itemType === k ? ' selected' : '') + '>' + l + '</option>').join('');
    let materialRow = '';
    if (it.itemType === 'material') {
      const opts = '<option value="">Criar novo material com esta descricao</option>' + nfMaterials.map(m => '<option value="' + m.id + '"' + (m.id === it.materialId ? ' selected' : '') + '>' + esc(m.name) + ' (' + esc(m.unit) + ')</option>').join('');
      materialRow = '<div style="margin-top:4px;font-size:11px;color:#6b7280;">Entra no estoque como: <select style="font-size:11px;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px;max-width:260px;" onchange="nfDraft.items[' + idx + '].materialId=this.value">' + opts + '</select></div>';
    }
    h += '<tr>'
      + '<td><input style="' + inputStyle + '" value="' + esc(it.description) + '" oninput="nfDraft.items[' + idx + '].description=this.value">' + materialRow + '</td>'
      + '<td><select style="' + inputStyle + '" onchange="nfSetItemType(' + idx + ', this.value)">' + typeOptions + '</select></td>'
      + '<td><input style="' + inputStyle + '" type="number" step="any" value="' + (it.quantity || 0) + '" oninput="nfSetItemNumber(' + idx + ', \'quantity\', this.value)"></td>'
      + '<td><input style="' + inputStyle + '" value="' + esc(it.unit || '') + '" oninput="nfDraft.items[' + idx + '].unit=this.value"></td>'
      + '<td><input style="' + inputStyle + '" type="number" step="any" value="' + (it.unitValue || 0) + '" oninput="nfSetItemNumber(' + idx + ', \'unitValue\', this.value)"></td>'
      + '<td><input style="' + inputStyle + '" type="number" step="any" id="nfItemTotal' + idx + '" value="' + (it.totalValue || 0) + '" oninput="nfSetItemNumber(' + idx + ', \'totalValue\', this.value)"></td>'
      + '<td><a style="color:#dc2626;cursor:pointer;font-size:12px;" onclick="nfRemoveItem(' + idx + ')">Remover</a></td>'
      + '</tr>';
  });
  h += '</tbody></table>';
  c.innerHTML = h;
  nfUpdateTotals();
}

function nfSetItemType(idx, type) {
  nfDraft.items[idx].itemType = type;
  if (type === 'material') nfAutoMatchMaterials();
  nfRenderItems();
}

function nfSetItemNumber(idx, key, value) {
  const it = nfDraft.items[idx];
  it[key] = parseFloat(value) || 0;
  if (key === 'quantity' || key === 'unitValue') {
    it.totalValue = Math.round(it.quantity * it.unitValue * 100) / 100;
    const el = document.getElementById('nfItemTotal' + idx);
    if (el) el.value = it.totalValue;
  }
  nfUpdateTotals();
}

function nfAddItem() { nfDraft.items.push(nfNewItem()); nfRenderItems(); }
function nfRemoveItem(idx) { nfDraft.items.splice(idx, 1); if (!nfDraft.items.length) nfDraft.items.push(nfNewItem()); nfRenderItems(); }

function nfItemsSum() { return Math.round(nfDraft.items.reduce((s, i) => s + (i.totalValue || 0), 0) * 100) / 100; }

function nfUpdateTotals() {
  const el = document.getElementById('nfTotalsCheck');
  if (!el) return;
  const sum = nfItemsSum();
  const total = nfDraft.totalValue || 0;
  if (!total) el.innerHTML = '<span style="color:#6b7280;">Soma dos itens: ' + fmtMoney(sum) + ' (sera usada como total)</span>';
  else if (Math.abs(sum - total) > 0.05) el.innerHTML = '<span style="color:#9a3412;">⚠️ Soma dos itens (' + fmtMoney(sum) + ') diferente do total da nota. Pode ser frete, desconto ou imposto: confira.</span>';
  else el.innerHTML = '<span style="color:#065f46;">✓ Soma dos itens confere com o total</span>';
  nfRenderPrPreview();
}

// ---------- Vinculo com solicitacao de compra ----------
function nfProjectPurchaseRequests() {
  const projectId = document.getElementById('nfProject').value;
  return nfPurchaseRequests.filter(r => r.projectId === projectId && r.status !== 'rejected');
}

function nfSuggestPurchaseRequest(list) {
  const total = nfDraft.totalValue || nfItemsSum();
  const supplier = normKey(nfDraft.supplierName);
  const itemText = normKey(nfDraft.items.map(i => i.description).join(' '));
  let best = null, bestScore = 0;
  list.forEach(r => {
    let score = 0;
    if (supplier && (r.quotes || []).some(q => { const k = normKey(q.supplierName); return k && (supplier.indexOf(k) > -1 || k.indexOf(supplier) > -1); })) score += 2;
    if (total && r.estimatedValue) {
      const diff = Math.abs(total - r.estimatedValue) / r.estimatedValue;
      if (diff <= 0.1) score += 2; else if (diff <= 0.25) score += 1;
    }
    const nameKey = normKey(r.itemName);
    if (nameKey && nameKey.length > 3 && itemText.indexOf(nameKey) > -1) score += 2;
    if (r.status === 'delivered') score -= 1;
    if (score > bestScore) { bestScore = score; best = r; }
  });
  return bestScore >= 2 ? best : null;
}

function nfRenderPrSelect() {
  const sel = document.getElementById('nfPrSelect');
  if (!sel) return;
  const list = nfProjectPurchaseRequests();
  const suggested = nfSuggestPurchaseRequest(list);
  if (!nfDraft.purchaseRequestId && suggested) { nfDraft.purchaseRequestId = suggested.id; nfDraft.deductFromPurchase = true; }
  if (nfDraft.purchaseRequestId && !list.some(r => r.id === nfDraft.purchaseRequestId)) { nfDraft.purchaseRequestId = ''; nfDraft.deductFromPurchase = false; }
  sel.innerHTML = '<option value="">Compra direta (sem solicitacao)</option>' + list.map(r => (
    '<option value="' + r.id + '"' + (r.id === nfDraft.purchaseRequestId ? ' selected' : '') + '>'
    + (suggested && r.id === suggested.id ? '⭐ Sugerida: ' : '') + esc(r.itemName) + ' - aprovado ' + fmtMoney(r.estimatedValue) + ' (' + (PURCHASE_STATUS_LABELS[r.status] || r.status) + ')</option>'
  )).join('');
  const chk = document.getElementById('nfDeductPurchase');
  chk.disabled = !nfDraft.purchaseRequestId;
  chk.checked = !!nfDraft.purchaseRequestId && nfDraft.deductFromPurchase;
  nfRenderPrPreview();
}

function nfOnPrChange(value) {
  nfDraft.purchaseRequestId = value;
  nfDraft.deductFromPurchase = !!value;
  const chk = document.getElementById('nfDeductPurchase');
  chk.disabled = !value;
  chk.checked = !!value;
  nfRenderPrPreview();
}

function nfOnProjectChange() {
  if (!nfDraft) return;
  nfDraft.purchaseRequestId = '';
  nfDraft.deductFromPurchase = false;
  nfRenderPrSelect();
}

function nfRenderPrPreview() {
  const el = document.getElementById('nfPrPreview');
  if (!el) return;
  const pr = nfPurchaseRequests.find(r => r.id === nfDraft.purchaseRequestId);
  if (!pr) { el.innerHTML = ''; return; }
  const total = nfDraft.totalValue || nfItemsSum();
  const already = pr.invoiceValue || 0;
  const thisNote = nfDraft.deductFromPurchase ? total : 0;
  const saldo = (pr.estimatedValue || 0) - already - thisNote;
  el.innerHTML = 'Valor aprovado ' + fmtMoney(pr.estimatedValue) + ' &minus; notas anteriores ' + fmtMoney(already) + ' &minus; esta nota ' + fmtMoney(thisNote)
    + ' = <strong style="color:' + (saldo < 0 ? '#991b1b' : '#065f46') + ';">saldo ' + fmtMoney(saldo) + '</strong>'
    + (saldo < 0 ? ' <span style="color:#991b1b;">(acima do aprovado)</span>' : '');
}

// ---------- Salvar ----------
async function nfSave(force) {
  if (!nfDraft) return;
  const projectId = document.getElementById('nfProject').value;
  const items = nfDraft.items.filter(i => String(i.description || '').trim());
  if (!projectId) { nfShowError('Selecione a obra.'); return; }
  if (!items.length) { nfShowError('Preencha a descricao de pelo menos um item.'); return; }
  if (nfDraft.duplicate && !force && !confirm('Esta nota parece ja ter sido lancada. Salvar mesmo assim?')) return;
  nfShowError('');
  const btn = document.getElementById('nfSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  const body = {
    projectId,
    purchaseRequestId: nfDraft.purchaseRequestId || null,
    number: nfDraft.number, series: nfDraft.series, accessKey: nfDraft.accessKey,
    supplierName: nfDraft.supplierName, supplierCnpj: nfDraft.supplierCnpj, issueDate: nfDraft.issueDate,
    totalValue: nfDraft.totalValue || nfItemsSum(),
    sourceType: nfDraft.sourceType,
    deductFromBudget: !!nfDraft.deductFromBudget,
    deductFromPurchase: !!(nfDraft.purchaseRequestId && nfDraft.deductFromPurchase),
    items: items.map(i => ({ ...i, materialId: i.itemType === 'material' ? (i.materialId || null) : null })),
    file: nfDraft.file,
    force: !!(force || nfDraft.duplicate)
  };
  try {
    const res = await fetch(API + '/api/v1/invoices', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    const d = await res.json();
    if (res.status === 409 && d.duplicate) {
      btn.disabled = false; btn.textContent = 'Salvar nota';
      if (confirm(d.error + ' Salvar mesmo assim?')) return nfSave(true);
      return;
    }
    if (!res.ok) throw new Error(d.error || 'Erro ao salvar');
    closeModal('nfModal');
    alert('Nota salva. ' + (d.stockEntries ? d.stockEntries + ' item(ns) de material entraram no estoque.' : 'Nenhum item foi para o estoque (equipamentos e servicos ficam registrados na nota).'));
    loadNotasView();
  } catch (e) { nfShowError(e.message); }
  btn.disabled = false;
  btn.textContent = 'Salvar nota';
}
