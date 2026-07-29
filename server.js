const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/v1/health') {
    return res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      name: 'ConstructFlow API',
      timestamp: new Date().toISOString()
    }));
  }

  res.end(JSON.stringify({
    message: 'ConstructFlow API rodando!',
    routes: ['GET /api/v1/health']
  }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
