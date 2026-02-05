FROM debian:12

WORKDIR /opt/RR-WhatsApp-API

RUN apt update && apt install -y \
  git nodejs npm psmisc \
  ca-certificates fonts-liberation libappindicator3-1 libatk-bridge2.0-0 libcups2 \
  libdrm-dev libgbm-dev libgtk-3-0 libnspr4 libnss3 libxss1 \
  lsb-release xdg-utils libasound2 libdrm2 libxcomposite1 libxrandr2 \
  libgbm1 \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm install

EXPOSE 3001 8080

CMD ["node", "index.js"]
