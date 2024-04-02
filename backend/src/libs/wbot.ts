import { Client, LocalAuth, DefaultOptions } from "whatsapp-web.js";
import path from "path";
import { rm } from "fs/promises";
import { getIO } from "./socket";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import SyncUnreadMessagesWbot from "../services/WbotServices/SyncUnreadMessagesWbot";
import Queue from "./Queue";
import AppError from "../errors/AppError";

interface Session extends Client {
  id: number;
  checkMessages: any;
}

const sessions: Session[] = [];

const checking: any = {};

const minimal_args = [
  "--autoplay-policy=user-gesture-required",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-features=AudioServiceOutOfProcess",
  "--disable-gpu",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-notifications",
  "--disable-offer-store-unmasked-wallet-cards",
  "--disable-popup-blocking",
  "--disable-print-preview",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-setuid-sandbox",
  "--disable-speech-api",
  "--disable-sync",
  "--hide-scrollbars",
  "--ignore-gpu-blacklist",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--no-pings",
  "--no-sandbox",
  "--no-zygote",
  "--password-store=basic",
  "--use-gl=swiftshader",
  "--use-mock-keychain"
];

export const apagarPastaSessao = async (id: number | string): Promise<void> => {
  const pathRoot = path.resolve(__dirname, "..", "..", ".wwebjs_auth");
  const pathSession = `${pathRoot}/session-wbot-${id}`;
  try {
    await rm(pathSession, { recursive: true, force: true });
  } catch (error) {
    logger.info(`apagarPastaSessao:: ${pathSession}`);
    logger.error(error);
  }
};

export const removeWbot = (whatsappId: number): void => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      sessions[sessionIndex].destroy();
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(`removeWbot | Error: ${err}`);
  }
};

const checkMessages = async (wbot: Session, tenantId: number | string) => {
  try {
    const isConnectStatus = wbot && (await wbot.getState()) === "CONNECTED"; // getValue(`wbotStatus-${tenantId}`);
    logger.info(
      "wbot:checkMessages:status",
      wbot.id,
      tenantId,
      isConnectStatus
    );

    if (isConnectStatus) {
      logger.info("wbot:connected:checkMessages", wbot, tenantId);
      Queue.add("SendMessages", { sessionId: wbot.id, tenantId });
    }
  } catch (error) {
    const strError = String(error);
    // se a sessão tiver sido fechada, limpar a checagem de mensagens e bot
    if (strError.indexOf("Session closed.") !== -1) {
      logger.error(
        `BOT Whatsapp desconectado. Tenant: ${tenantId}:: BOT ID: ${wbot.id}`
      );
      clearInterval(wbot.checkMessages);
      removeWbot(wbot.id);
      return;
    }
    logger.error(`ERROR: checkMessages Tenant: ${tenantId}::`, error);
  }
};

export const initWbot = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      const io = getIO();
      const sessionName = whatsapp.name;
      const { tenantId } = whatsapp;
      let sessionCfg;
      if (whatsapp?.session) {
        sessionCfg = JSON.parse(whatsapp.session);
      }

      const wbot = new Client({
        authStrategy: new LocalAuth({ clientId: `wbot-${whatsapp.id}` }),
        puppeteer: {
          // headless: false,
          executablePath: process.env.CHROME_BIN || undefined,
          args: [`--user-agent=${DefaultOptions.userAgent}`, ...minimal_args]
        }
      }) as Session;

      wbot.id = whatsapp.id;

      wbot.initialize();

      wbot.on("qr", async qr => {
        if (whatsapp.status === "CONNECTED") return;
        logger.info(
          `Session QR CODE: ${sessionName}-ID: ${whatsapp.id}-${whatsapp.status}`
        );

        await whatsapp.update({ qrcode: qr, status: "qrcode", retries: 0 });
        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex === -1) {
          wbot.id = whatsapp.id;
          sessions.push(wbot);
        }

        io.emit(`${tenantId}:whatsappSession`, {
          action: "update",
          session: whatsapp
        });
      });

      wbot.on("authenticated", async () => {
        logger.info(`Session: ${sessionName} AUTHENTICATED`);
      });

      wbot.on("auth_failure", async msg => {
        logger.error(
          `Session: ${sessionName}-AUTHENTICATION FAILURE :: ${msg}`
        );
        if (whatsapp.retries > 1) {
          await whatsapp.update({
            retries: 0,
            session: ""
          });
        }

        const retry = whatsapp.retries;
        await whatsapp.update({
          status: "DISCONNECTED",
          retries: retry + 1
        });

        io.emit(`${tenantId}:whatsappSession`, {
          action: "update",
          session: whatsapp
        });
        reject(new Error("Error starting whatsapp session."));
      });

      wbot.on("ready", async () => {
        logger.info(`Session: ${sessionName}-READY`);

        const info: any = wbot?.info;
        await whatsapp.update({
          status: "CONNECTED",
          qrcode: "",
          retries: 0,
          number: wbot?.info?.wid?.user, // || wbot?.info?.me?.user,
          phone: info?.phone || {}
        });

        io.emit(`${tenantId}:whatsappSession`, {
          action: "update",
          session: whatsapp
        });

        io.emit(`${tenantId}:whatsappSession`, {
          action: "readySession",
          session: whatsapp
        });

        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex === -1) {
          wbot.id = whatsapp.id;
          sessions.push(wbot);
        }

        wbot.sendPresenceAvailable();
        SyncUnreadMessagesWbot(wbot, tenantId);
        resolve(wbot);
      });

      wbot.checkMessages = setInterval(
        checkMessages,
        +(process.env.CHECK_INTERVAL || 5000),
        wbot,
        tenantId
      );
      // WhatsappConsumer(tenantId);
    } catch (err) {
      logger.error(`initWbot error | Error: ${err}`);
    }
  });
};

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }

  return sessions[sessionIndex];
};
