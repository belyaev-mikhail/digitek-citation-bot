import * as tl from "node-telegram-bot-api";

declare var BOT_TOKEN;
declare var SCRIPT_ID;

const telegramUrl = () => `https://api.telegram.org/bot${BOT_TOKEN}`;
const webAppUrl = () => `https://script.google.com/macros/s/${SCRIPT_ID}/exec`;

const getCitationSheet = () => SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
const getDataSheet = () => SpreadsheetApp.getActiveSpreadsheet().getSheets()[1];
const getDebugSheet = () => SpreadsheetApp.getActiveSpreadsheet().getSheets()[2];

const SIG = "@digitek_citation_bot";

function getMe() {
    var url = `${telegramUrl()}/getMe`;
    var response = UrlFetchApp.fetch(url);
    Logger.log(response.getContentText());
}

function unsetWebhook() {
    var url = `${telegramUrl()}/setWebhook?url=`;
    var response = UrlFetchApp.fetch(url);
    Logger.log(response.getContentText());
}

function setWebhook() {
    var url = `${telegramUrl()}/setWebhook?url=${webAppUrl()}`;
    var response = UrlFetchApp.fetch(url);
    Logger.log(response.getContentText());
}

function sendText(id, text) {
    var response = UrlFetchApp.fetch(`${telegramUrl()}/sendMessage`, {
        method: 'post',
        payload: {
            chat_id: "" + id,
            text: text
        }
    });
    Logger.log(response.getContentText());
}

function UUID() {
    return Utilities.getUuid()
}

function doGet(e) {
    return HtmlService.createHtmlOutput("Hi there");
}

function getRandom() {
    var max = getCitationSheet().getLastRow() - 1;
    var random = Math.round(Math.random() * max) + 1;
    var range = getCitationSheet().getRange(random, 1, 1, 3);
    return range.getValues()[0]
}

function isAllowed(id) {
    var sheet = getDataSheet();

    var row;
    for (row = 2; row <= sheet.getLastRow(); ++row) if (id == sheet.getRange(row, 1).getValue()) return true;
    return false
}

var lastMessage;

function citeOfTheDay() {
    var sheet = getDataSheet();

    var row;
    for (row = 2; row <= sheet.getLastRow(); ++row) {
        var id = +sheet.getRange(row, 1).getValue();
        if (id < 0) {
            var range = getRandom();
            sendText(id, "Цитата дня:\n" + range[1] + " (c) " + range[0])
        }
    }
}

// this is somehow not in telegram's type definitions
interface TlUpdateFix {
    message ?: {
        forward_sender_name?: string
    }
}

type TlUpdate = tl.Update & TlUpdateFix;
type Message = TlUpdate['message']

function getForwardedName(m: Message) {
    if(m.forward_from) {
        return m.forward_from.first_name || m.forward_from.last_name || m.forward_from.username
    }
    if(m.forward_sender_name) {
        return m.forward_sender_name.split(" ")[0]
    }
    if(m.forward_signature) {
        return m.forward_signature
    }
    return "Some guy"
}

function success(id: number) {
    const variants = [
        "Ok",
        "k",
        "Понял, принял",
        "Ладушки",
        "Принято",
        "+",
        "Ладно, ладно"
    ];

    const ok = variants[Math.floor(Math.random() * variants.length)];

    sendText(id, ok);
}

function doPost(e) {
    getDebugSheet().appendRow([e.postData.contents]);

    var data = JSON.parse(e.postData.contents) as TlUpdate;
    if (!data.message) return;

    lastMessage = data.message;

    var text = data.message.text;
    var id = data.message.chat.id;

    if (!text) return;

    text = text.replace(SIG, "");

    if (text.split(" ")[0] === "/uuid") {
        text = text.replace("/uuid", "").trim()
    }

    if (text.trim() === getDataSheet().getRange(1, 1).getValue()) {
        if (isAllowed(id)) return;
        getDataSheet().appendRow([id]);
        sendText(id, "Ок, погнали");
        return;
    }

    if (!isAllowed(id)) {
        sendText(id, "Ты кто? Пришли мне данные ячейки A1 из таблицы 'Data' плез");
        return;
    }

    if (text.trim() === '/random') {
        var range = getRandom();
        sendText(id, `${range[1]} (c) ${range[0]}`);
        return;
    }

    if (data.message.chat.type === "private") {
        if (!data.message.forward_from && !data.message.forward_sender_name) return;
        var name = getForwardedName(data.message);
        success(id);
        getCitationSheet().appendRow([name, text, `by ${SIG}`]);
    }

    if (text.trim() === "/cite") {
        if (!data.message.reply_to_message) {
            sendText(id, "Я умею цитировать только реплаи, сорян\nМожешь зафорвардить сообщение мне в личку");
            return;
        }
        var rm = data.message.reply_to_message;
        var name = rm.from.first_name || rm.from.username;
        var text = rm.text;
        success(id);
        getCitationSheet().appendRow([name, text, `by ${SIG}`]);
    }

    if(text.trim().startsWith("/cite")) {
        const tryout = text.replace("/cite", "").replace("(с)", "(c)").trim().split("(c)");
        if(tryout.length != 2) {
            sendText(id, "Попробуй так: /cite Сообщение (c) Вася");
            return;
        }
        const [ctext, name] = tryout;
        success(id);
        getCitationSheet().appendRow([name.trim(), ctext.trim(), `by ${SIG}`]);
    }
}
