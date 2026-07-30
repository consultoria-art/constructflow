# 1. Defina suas credenciais (Substitua os valores abaixo)
TOKEN="SEU_TOKEN_AQUI"
USER="SEU_USUARIO_AQUI"
REPO="SEU_REPOSITORIO_AQUI"

# 2. Busca automática do SHA atual
SHA=$(curl -s -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://github.com" | grep '"sha":' | head -n 1 | cut -d'"' -f4)

# 3. Código do server.js convertido para Base64 (Porta 888)
CONTENT="Y29uc3QgZXhwcmVzcyA9IHJlcXVpcmUoJ2V4cHJlc3MnKTsKY29uc3QgeyBQcmlzbWFDbGllbnQgfSA9IHJlcXVpcmUoJ0BwcmlzbWEvY2xpZW50Jyk7CmYgPSBuZXcgUHJpc21hQ2xpZW50KCk7CmNvbnN0IGFwcCA9IGV4cHJlc3MoKTsKY29uc3QgUE9SUSA9IHByb2Nlc3MuZW52LlBPUlQgfHwgODg4OwoKYXBwLnVzZShleHByZXNzLmpzb24oKSk7CgphcHAuZ2V0KCcvJywgKHJlcSwgcmVzKSA9PiB7CiAgICByZXMuc2VuZCgnT0s6IHBvcnRhIDg4OCcpOwp9KTsKCmFwcC5saXN0ZW4oUE9SVCwgKCkgPT4gewogICAgY29uc29sZS5sb2coYFNlcnZpZG9yIHJvZGFuZG8gbmEgcG9ydGEgJHtQT1JUfWApOwp9KTs="

# 4. Envio do PUT para o GitHub
curl -X PUT \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Fix server.js via cURL\",\"content\":\"$CONTENT\",\"sha\":\"$SHA\"}" \
  "https://github.com"
