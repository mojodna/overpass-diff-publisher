FROM node:8

ARG NODE_ENV=production
ENV NPM_CONFIG_LOGLEVEL warn

WORKDIR /opt/app

COPY package.json /opt/app/

RUN npm install \
  && rm -rf /root/.npm

COPY . /opt/app

ENTRYPOINT ["node", "index.js"]
