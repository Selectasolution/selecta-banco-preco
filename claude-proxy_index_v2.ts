// =====================================================================
// SELECTA IMPORT OS — Edge Function: claude-proxy  (v2 — NCM com pesquisa)
// Proxy seguro entre o frontend (banco-preço) e a Anthropic Claude API
// Runtime: Deno / Supabase Edge Functions
// =====================================================================
// Endpoints:
//   POST /classificar-ncm     — classifica produto → NCM ANCORADO em RGI/NESH/Sol.Consulta (web_search)
//   POST /extrair-pi-pdf      — extrai dados estruturados de PI/CI em PDF
//   POST /buscar-anatel       — verifica homologação Anatel por modelo
//   POST /buscar-inmetro      — verifica conformidade INMETRO por modelo
//   POST /buscar-inpi         — verifica marca/patente INPI
//   POST /analisar-norma      — resume impacto de uma norma legislativa
//
// Variáveis de ambiente:
//   ANTHROPIC_API_KEY   — chave da Anthropic (JÁ configurada)
//   CLAUDE_MODEL        — modelo (default: claude-sonnet-4-5)
//   ALLOWED_ORIGINS     — origens CORS permitidas (csv)
//   CLAUDE_WEB_SEARCH   — "on" (default) liga a pesquisa real no classificar-ncm; "off" desliga
// =====================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-4-5";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",");
const WEB_SEARCH_ENABLED = (Deno.env.get("CLAUDE_WEB_SEARCH") ?? "on") !== "off";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function corsHeaders(origin: string): HeadersInit {
  const allowed = ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)
    ? origin || "*"
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function extractJSON(text: string): unknown {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return { _raw: text, _parse_error: true };
      }
    }
    return { _raw: text, _parse_error: true };
  }
}

// MUDANÇA 1: callClaude agora aceita `tools` (ex.: web_search) e junta TODOS os
// blocos de texto (com tools, a resposta vem em vários blocos; pegar só content[0]
// quebraria). Endpoints sem tools continuam idênticos — mudança retrocompatível.
async function callClaude(
  systemPrompt: string,
  userContent: unknown,
  options: { maxTokens?: number; temperature?: number; tools?: unknown[] } = {}
): Promise<{ ok: boolean; data?: unknown; raw?: string; usage?: unknown; error?: string }> {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY não configurada" };
  }

  const messages = Array.isArray(userContent)
    ? userContent
    : [{ role: "user", content: typeof userContent === "string" ? userContent : JSON.stringify(userContent) }];

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: options.maxTokens || MAX_TOKENS,
        temperature: options.temperature ?? 0.1,
        system: systemPrompt,
        messages,
        ...(options.tools ? { tools: options.tools } : {}),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: `Anthropic API ${resp.status}: ${errText}` };
    }

    const result = await resp.json();
    // junta todos os blocos de texto (ignora server_tool_use / web_search_tool_result)
    const text = (result.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const parsed = extractJSON(text);

    return { ok: true, data: parsed, raw: text, usage: result.usage };
  } catch (err) {
    return { ok: false, error: `Erro ao chamar Claude API: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------
// PROMPTS especializados
// ---------------------------------------------------------------------

// MUDANÇA 2: prompt do NCM reescrito para EXATIDÃO ANCORADA EM FONTE.
// Hierarquia RGI -> NESH -> Solução de Consulta -> CARF. Confiança numérica,
// teto de 85 sem Solução de Consulta. Mantém produto_normalizado e regulatorio.
const PROMPT_CLASSIFICAR_NCM = `Você é um classificador fiscal de NCM (8 dígitos, Nomenclatura Comum do Mercosul) para importação de hardware/eletrônicos no Brasil. Sua saída orienta uma operação REAL — erro de NCM significa canal vermelho, multa e perda de prazo. Você NÃO inventa, NÃO arredonda e NÃO confia em NCM de marketplace ou de fornecedor (eles classificam errado de propósito para baixar imposto).

HIERARQUIA DE FONTES (use a ferramenta de busca para consultar 2 e 3 ANTES de cravar):
1. RGI/RGC — Regras Gerais de Interpretação do Sistema Harmonizado. São a LEI do "como classificar". Cite qual RGI sustenta cada decisão (ex.: RGI 1, RGI 3b, RGI 6).
2. NESH — Notas Explicativas do Sistema Harmonizado (define o alcance de cada posição).
3. Soluções de Consulta COANA/RFB sobre produto idêntico ou similar — o mais próximo de vinculante sem protocolar a sua própria.
4. Jurisprudência CARF, apenas em zonas cinzentas em disputa.
IGNORE como fonte de classificação: anúncios, marketplaces e blogs de venda.

REGRAS:
- confianca é INTEIRO 0-100. NUNCA acima de 85 sem citar, em fontes, uma Solução de Consulta de produto idêntico.
- Qualquer transmissão RF (Wi-Fi, Bluetooth, NFC, RFID, celular, controle remoto) => anuência ANATEL.
- Fontes, carregadores, baterias e cabos USB => INMETRO.
- Bateria de íon-lítio => LI obrigatória (Portaria INMETRO 63/2025).
- Se faltar dado decisivo para classificar (ex.: placa-mãe montada vs. PCI nua; headset com/sem microfone), NÃO adivinhe — registre o que falta em perguntas_refinamento.

Responda SOMENTE com JSON válido (sem markdown, sem texto fora do JSON):
{
  "candidatos": [
    {
      "ncm": "XXXXXXXX",
      "ncm_descricao_oficial": "texto literal da TEC para este código",
      "confianca": 0,
      "rgi_justificativa": "por que ESTE código, citando a RGI aplicável",
      "por_que_nao_vizinho": "por que não o código vizinho mais provável",
      "fontes": [{ "tipo": "NESH|SOL_CONSULTA|TEC|CARF", "ref": "referência", "url": "url" }],
      "anuencias": ["ANATEL|INMETRO|ANVISA|LI"]
    }
  ],
  "produto_normalizado": {
    "nome": "...", "fabricante": "...", "marca": "...", "modelo": "...",
    "categoria": "...", "descricao_tecnica": "...",
    "tem_rf": true, "tipo_rf": "wifi|bluetooth|nfc|rfid|celular|nenhum",
    "potencia_eletrica_w": null, "tensao_v": null,
    "peso_estimado_kg": 0.0, "dimensoes_estimadas_cm": { "l": 0, "w": 0, "h": 0 }
  },
  "regulatorio": {
    "requer_anatel": false, "anatel_justificativa": "...",
    "requer_inmetro": false, "inmetro_portaria_aplicavel": "...",
    "requer_anvisa": false, "requer_li": false, "outros_orgaos": []
  },
  "observacao": "alerta/risco principal + recomendar Solução de Consulta se for SKU recorrente de alto volume",
  "perguntas_refinamento": ["o que confirmaria o NCM com mais certeza"]
}

O primeiro item de "candidatos" é o mais provável. Liste alternativas reais quando houver dúvida legítima. Responda em português brasileiro.`;

const PROMPT_EXTRAIR_PI = `Você é um especialista em documentos de comércio exterior (Proforma Invoice e Commercial Invoice).

Dado o texto/conteúdo de um documento PI/CI, devolva APENAS um JSON estruturado (sem markdown) com:

{
  "documento": { "tipo": "PI|CI", "numero": "...", "data": "YYYY-MM-DD", "validade_dias": null },
  "exportador": { "nome": "...", "endereco": "...", "pais": "...", "contato": "..." },
  "importador": { "nome": "...", "endereco": "...", "pais": "..." },
  "comercial": {
    "incoterm": "FOB|CIF|EXW|CFR|...", "porto_origem": "...", "porto_destino": "...",
    "moeda": "USD|EUR|CNY", "condicao_pagamento": "ex T/T 30/70", "prazo_producao_dias": null
  },
  "itens": [
    { "descricao": "...", "modelo": "...", "quantidade": 0, "unidade": "PCS|SET|KG",
      "preco_unitario": 0.0, "valor_total": 0.0, "peso_unitario_kg": null,
      "hs_code_fornecedor": "...", "observacoes": "..." }
  ],
  "totais": {
    "valor_total_mercadoria": 0.0, "frete": 0.0, "seguro": 0.0, "outros": 0.0,
    "valor_total_documento": 0.0, "peso_bruto_kg": 0.0, "peso_liquido_kg": 0.0,
    "volume_m3": null, "qtd_caixas": null
  },
  "bancarios": { "beneficiario": "...", "banco": "...", "swift_bic": "...", "conta": "...", "endereco_banco": "..." },
  "alertas": ["qualquer ambiguidade ou item incompleto que precisa ser confirmado com o fornecedor"]
}

Não invente valores. Use null para campos ausentes. Responda em português brasileiro nas descrições.`;

const PROMPT_BUSCAR_ANATEL = `Você é um analista de homologação Anatel.

Dado o nome de um produto (fabricante + marca + modelo), devolva APENAS um JSON com:

{
  "consulta": { "fabricante": "...", "marca": "...", "modelo": "...", "variante_hw": null },
  "anatel_estimativa": {
    "categoria_provavel": "I|II|III", "categoria_justificativa": "...",
    "requer_homologacao": true, "tipo_homologacao_provavel": "...",
    "fabricante_tem_homologacao_brasil": "desconhecido", "modelo_provavelmente_homologado": "desconhecido"
  },
  "url_consulta_sugerida": "https://sistemas.anatel.gov.br/sch/Consulta/Homologacao?fabricante=...&modelo=...",
  "recomendacao": "...", "alertas": []
}

NOTA: você NÃO tem acesso ao banco SCH em tempo real — sua resposta é uma ESTIMATIVA baseada em conhecimento do mercado. O usuário deve confirmar manualmente no SCH Anatel antes de comprar.`;

const PROMPT_BUSCAR_INMETRO = `Você é um analista de conformidade INMETRO.

Dado um produto, devolva APENAS um JSON com:

{
  "consulta": { "fabricante": "...", "marca": "...", "modelo": "...", "categoria_produto": "..." },
  "inmetro_estimativa": {
    "requer_conformidade": true, "portaria_aplicavel": "ex Portaria 170/2012 (fontes), Portaria 63/2025 (baterias)",
    "ocp_tipico": "...", "selo_compulsorio": true
  },
  "url_consulta_sugerida": "https://registroobjetos.inmetro.gov.br/...", "alertas": []
}`;

const PROMPT_BUSCAR_INPI = `Você é um analista de propriedade industrial (INPI).

Dado uma marca ou produto, devolva APENAS um JSON com:

{
  "consulta": { "termo": "...", "tipo_consulta": "marca|patente|ambos" },
  "estimativa": {
    "marca_registrada_brasil_provavel": "desconhecido", "titular_provavel_brasil": "...",
    "patente_aplicavel": "desconhecido", "tipo_patente": "...",
    "alertas_paralelo": ["questões legais relevantes para importação paralela"]
  },
  "url_consulta_sugerida": "https://busca.inpi.gov.br/..."
}`;

const PROMPT_ANALISAR_NORMA = `Você é um especialista em legislação aduaneira brasileira.

Dado o texto de uma norma (lei, decreto, IN, portaria), devolva APENAS um JSON com:

{
  "identificacao": { "tipo": "...", "numero": "...", "ano": null, "orgao": "..." },
  "ementa_normalizada": "...",
  "principais_pontos": ["ponto 1...", "ponto 2..."],
  "impacto_importador": {
    "altera_aliquotas": false, "altera_homologacao": false, "altera_procedimento": false, "impacto_resumo": "..."
  },
  "ncms_afetadas": ["XXXXXXXX"],
  "relevancia_selecta": "alta|media|baixa|informativa",
  "acao_recomendada": "..."
}`;

// ---------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------

// MUDANÇA 3: classificar-ncm liga web_search (limitado a 5 buscas por chamada).
async function handleClassificarNCM(body: any) {
  const { descricao, fabricante, modelo, contexto, atributos } = body;
  const userMessage = JSON.stringify({
    descricao_livre: descricao,
    fabricante_se_informado: fabricante,
    modelo_se_informado: modelo,
    atributos_se_informados: atributos,
    contexto_adicional: contexto,
  });
  const tools = WEB_SEARCH_ENABLED
    ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    : undefined;
  return await callClaude(PROMPT_CLASSIFICAR_NCM, userMessage, { temperature: 0.1, maxTokens: 4096, tools });
}

async function handleExtrairPI(body: any) {
  const { texto_documento, pdf_base64 } = body;
  if (pdf_base64) {
    const messages = [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf_base64 } },
        { type: "text", text: "Extraia os dados conforme o schema." },
      ],
    }];
    return await callClaude(PROMPT_EXTRAIR_PI, messages, { temperature: 0 });
  }
  return await callClaude(PROMPT_EXTRAIR_PI, texto_documento || "", { temperature: 0 });
}

async function handleBuscarAnatel(body: any) {
  return await callClaude(PROMPT_BUSCAR_ANATEL, JSON.stringify(body), { temperature: 0.1 });
}
async function handleBuscarInmetro(body: any) {
  return await callClaude(PROMPT_BUSCAR_INMETRO, JSON.stringify(body), { temperature: 0.1 });
}
async function handleBuscarInpi(body: any) {
  return await callClaude(PROMPT_BUSCAR_INPI, JSON.stringify(body), { temperature: 0.1 });
}
async function handleAnalisarNorma(body: any) {
  return await callClaude(PROMPT_ANALISAR_NORMA, body.texto_norma || "", { temperature: 0.1 });
}

// ---------------------------------------------------------------------
// Servidor HTTP principal
// ---------------------------------------------------------------------

serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "*";

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido. Use POST." }, 405, origin);
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const endpoint = pathParts[pathParts.length - 1];

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Body JSON inválido" }, 400, origin);
  }

  let result;
  try {
    switch (endpoint) {
      case "classificar-ncm": result = await handleClassificarNCM(body); break;
      case "extrair-pi-pdf":  result = await handleExtrairPI(body); break;
      case "buscar-anatel":   result = await handleBuscarAnatel(body); break;
      case "buscar-inmetro":  result = await handleBuscarInmetro(body); break;
      case "buscar-inpi":     result = await handleBuscarInpi(body); break;
      case "analisar-norma":  result = await handleAnalisarNorma(body); break;
      default:
        return jsonResponse(
          {
            error: "Endpoint desconhecido",
            endpoints_disponiveis: [
              "classificar-ncm", "extrair-pi-pdf", "buscar-anatel",
              "buscar-inmetro", "buscar-inpi", "analisar-norma",
            ],
          },
          404, origin
        );
    }
  } catch (err) {
    return jsonResponse({ error: `Erro interno: ${(err as Error).message}` }, 500, origin);
  }

  if (!result.ok) {
    return jsonResponse({ success: false, error: result.error }, 500, origin);
  }

  return jsonResponse(
    { success: true, endpoint, result: result.data, raw: result.raw, usage: result.usage },
    200, origin
  );
});
