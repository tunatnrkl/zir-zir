'use strict';

const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

createApp().listen(port, host, () => {
  console.log(`ZIR ZIR çalışıyor: http://localhost:${port}`);
});
