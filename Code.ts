import gas = GoogleAppsScript;
import * as tl from "node-telegram-bot-api";
import {InlineKeyboardButton, PhotoSize, Poll, PollOption} from "node-telegram-bot-api";
import BlobSource = GoogleAppsScript.Base.BlobSource;
import DoPost = GoogleAppsScript.Events.DoPost;
import {ok} from "assert";
import Sheet = GoogleAppsScript.Spreadsheet.Sheet;
import TriggerSource = GoogleAppsScript.Script.TriggerSource;

declare var BOT_TOKEN;
declare var SCRIPT_ID;

const telegramUrl = () => `https://api.telegram.org/bot${BOT_TOKEN}`;
const telegramFileUrl = () => `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const webAppUrl = () => `https://script.google.com/macros/s/${SCRIPT_ID}/exec`;

function getOrCreateSheet(name: string): Sheet {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
    let sheet = spreadsheet.getSheetByName(name)
    if (sheet == null) {
        sheet = spreadsheet.insertSheet()
        sheet.setName(name)
    }
    return sheet
}

const getCitationSheet = () => getOrCreateSheet("Citations");
const getDataSheet = () => getOrCreateSheet("Data");
const getDebugSheet = () => getOrCreateSheet("Debug");
const getPicSheet = () => getOrCreateSheet("Pics");
const getBanSheet = () => getOrCreateSheet("Ban")

const SIG = "@digitek_citation_bot";

type PoorStringSet = { [key: string]: true | undefined }

type CitationSourceMsg = {
    messageId: number,
    chatId: number
}

type CitationSource = CitationSourceMsg & ({
    type: "manual"
} | {
    type: "reply"
    replyTo: CitationSourceMsg // Not used yet
} | {
    type: "forward"
});

type EditableMessages = {
    [key: string]: number
}

function debug(value: any) {
    getDebugSheet().appendRow([(typeof value === 'string'? value: JSON.stringify(value))])
}

function cacheKey(source: CitationSourceMsg) {
    return `${source.chatId}###${source.messageId}`
}

function withLock(code: () => void) {
    const scriptLock = LockService.getDocumentLock();
    scriptLock.tryLock(30000);
    try {
        code()
    } finally {
        scriptLock.releaseLock()
    }
}

function evaluateEditableMessages() {
    const editableMessages: EditableMessages = {};
    const last = getCitationSheet().getLastRow();
    const vals = getCitationSheet().getRange(`F2:F${last}`).getValues();

    vals.forEach((val, ix) => {
        const source: CitationSource = JSON.parse(val[0] || "null");
        if (!source)
            return;

        if (source.type !== "manual")
            return;

        editableMessages[cacheKey(source)] = ix + 2;
    });
    return editableMessages;
}

function getOrEvaluateEditableMessages(): [EditableMessages, boolean] {
    const cache = CacheService.getDocumentCache();
    let emStr = cache.get("editableMessages");
    if (emStr) {
        return [JSON.parse(emStr), false];
    }
    let em = evaluateEditableMessages();
    return [em, true]
}

function putEditableMessagesToCache(em: EditableMessages) {
    CacheService.getDocumentCache().put("editableMessages", JSON.stringify(em), 21600);
}

function getEditableMessages(): EditableMessages {
    let em: EditableMessages = {};
    let evaluated: boolean = false;
    withLock(() => {
        [em, evaluated] = getOrEvaluateEditableMessages();
        if (evaluated)
            putEditableMessagesToCache(em);
    });

    return em;
}

function updateEditableMessagesCache(source: CitationSource, line: number) {
    if (source.type !== "manual")
        return;

    let em: EditableMessages = {};
    let evaluated: boolean = false;
    withLock(() => {
        [em, evaluated] = getOrEvaluateEditableMessages();
        em[cacheKey(source)] = line;
        putEditableMessagesToCache(em);
    })
}

function invalidateEditableMeessagesCache() {
    const cache = CacheService.getDocumentCache();
    cache.remove("editableMessages");
}

function banUser(user: string) {
    let bansheet = getBanSheet()
    bansheet.appendRow([user])
}

function getBanList(): PoorStringSet {
    let bansheet = getBanSheet()
    let banned = bansheet.getRange("A:A").getRichTextValues()
    let result: PoorStringSet = {}
    for (const b of banned.map(it => it && it[0].getText() || "")) {
        result[b] = true
    }
    return result
}

function clearBanList() {
    getBanSheet().clear()
}

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

type SendMessage = tl.SendMessageOptions & {
    chat_id: string | number,
    text?: string
}

function serialize(payload: object) {
    const result = {};
    for(const key in payload) if(payload.hasOwnProperty(key)) {
        const value = payload[key];
        if(value != null && value.getBlob) result[key] = value.getBlob();
        else if(value != null && typeof value === 'object') result[key] = JSON.stringify(value);
        else if(value != null && Array.isArray(value)) result[key] = JSON.stringify(value);
        else result[key] = value;
    }
    return result
}

function mdEscape(text: string) {
    // https://stackoverflow.com/questions/40626896/telegram-does-not-escape-some-markdown-characters
    return text
        .replace(/_/g, "\\_")
        .replace(/\*/g, "\\*")
        .replace(/\[/g, "\\[")
        .replace(/`/g, "\\`");
}


const MONO_FONT_FAMILY = "Roboto Mono";
const BOLD = SpreadsheetApp.newTextStyle().setBold(true).build();
const ITALIC = SpreadsheetApp.newTextStyle().setItalic(true).build();
const MONO = SpreadsheetApp.newTextStyle().setFontFamily(MONO_FONT_FAMILY).build();

function plainTextToRichText(text: string): gas.Spreadsheet.RichTextValue {
    return SpreadsheetApp.newRichTextValue().setText(text).build()
}

function messageToRichText(message: tl.Message): gas.Spreadsheet.RichTextValue {
    // TODO Tg docs says that future fersion of API will support nesting entities.
    // TODO the approach here does not support them
    // TODO underline and strikethrough are not supported by API yet
    const builder = SpreadsheetApp.newRichTextValue().setText(message.text);

    for (let entity of message.entities || []) {
        switch (entity.type) {
            case "bold":
                builder.setTextStyle(entity.offset, entity.offset + entity.length, BOLD);
                break;
            case "italic":
                builder.setTextStyle(entity.offset, entity.offset + entity.length, ITALIC);
                break;
            case "pre":
            case "code":
                builder.setTextStyle(entity.offset, entity.offset + entity.length, MONO);
                break;
            default:
                break;
        }
    }
    return builder.build()
}

function plainTextToMarkdown(text: string): string {
    return mdEscape(text)
}

function richTextToMarkdown(richText: gas.Spreadsheet.RichTextValue): string {
    let builder = "";
    for (let run of richText.getRuns()) {
        let escaped = mdEscape(run.getText());
        let style = run.getTextStyle();
        if (style.getFontFamily() == MONO_FONT_FAMILY) {
            builder += `\`${escaped}\``
        } else if (style.isBold()) {
            builder += `*${escaped}*`
        } else if (style.isItalic()) {
            builder += `_${escaped}_`
        } else {
            builder += `${escaped}`
        }
    }
    return builder
}

type TlResponse = { ok: false } | { ok: true, result: Message }

function sendText(id, text: string, likeButton: InlineKeyboardButton, parse_mode: tl.ParseMode | null = null) {
    if(text.length > 4096) {
        for(const chunk of text.match(/[^]{1,4096}/g)) {
            sendText(id, chunk, chunk.length < 4096 ? likeButton : null, parse_mode)
        }
        return
    }
    const payload: SendMessage = {
            chat_id: `${id}`,
            text: text,
            reply_markup: likeButton && {
                inline_keyboard: [[ likeButton ]]
            }
    };

    if (parse_mode) {
        payload.parse_mode = parse_mode
    }

    var response = UrlFetchApp.fetch(`${telegramUrl()}/sendMessage`, {
        method: 'post',
        payload: serialize(payload)
    });
    Logger.log(response.getContentText());
}

function sendPhoto(id, file: BlobSource) {
    const response = UrlFetchApp.fetch(`${telegramUrl()}/sendPhoto`, {
        method: 'post',
        payload: serialize({
            chat_id: `${id}`,
            photo: file
        })
    });
    Logger.log(response.getContentText());
}

function answerCallbackQuery(id: string, text: string) {
    const payload: tl.AnswerCallbackQueryOptions = {
        callback_query_id: id,
        text: text
    };
    var response = UrlFetchApp.fetch(`${telegramUrl()}/answerCallbackQuery`, {
        method: 'post',
        payload: serialize(payload)
    });
    Logger.log(response.getContentText());
}

function editMessageReplyMarkup(chat_id: number, message_id: number, newButton: InlineKeyboardButton | null) {
    const payload: tl.EditMessageCaptionOptions = {
        chat_id: "" + chat_id,
        message_id: message_id,
        reply_markup: {
            inline_keyboard: [[ newButton ]]
        }
    };
    var response = UrlFetchApp.fetch(`${telegramUrl()}/editMessageReplyMarkup`, {
        method: 'post',
        payload: serialize(payload)
    });
    Logger.log(response.getContentText());
}

function sendSticker(id, file_id) {
    var response = UrlFetchApp.fetch(`${telegramUrl()}/sendSticker`, {
        method: 'post',
        payload: {
            chat_id: "" + id,
            sticker: file_id
        }
    });
    Logger.log(response.getContentText());
}

type CachedPoll = Poll & { data: any }

function getPoll(id): CachedPoll | null {
    let cache = CacheService.getDocumentCache().get("Polls")
    if (!cache) return null
    let row = JSON.parse(cache)[id]
    if (!row) return null
    return row as CachedPoll
}

function setPoll(id, poll: Poll, data?: any): CachedPoll {
    let cache = CacheService.getDocumentCache().get("Polls")
    if (!cache) cache = "{}"
    let parsedCache = JSON.parse(cache)
    let existingPoll = parsedCache[id] as CachedPoll
    existingPoll = { ...poll, data: data || existingPoll.data }
    parsedCache[id] = existingPoll
    CacheService.getDocumentCache().put("Polls", JSON.stringify(parsedCache), 1200)
    return existingPoll
}

function updatePoll(poll: Poll) {
    withLock(() => setPoll(poll.id, poll))
}

function handlePollTrigger(e: gas.Events.AppsScriptEvent) {
    try {
        withLock(() => {
            for (const t of ScriptApp.getProjectTriggers()) {
                if (t.getUniqueId() == e.triggerUid) {
                    ScriptApp.deleteTrigger(t)
                    break
                }
            }
            let pollId = PropertiesService.getScriptProperties().getProperty(e.triggerUid)
            PropertiesService.getScriptProperties().deleteProperty(e.triggerUid)
            let poll = getPoll(pollId)
            debug(poll)
            if (poll.options[0].voter_count > poll.options[1].voter_count)
                banUser("" + poll.data)
        })
    } catch (ex) {
        debug(ex)
    }
}

function sendBanPoll(id, user: string) {
    const response = UrlFetchApp.fetch(`${telegramUrl()}/sendPoll`, {
        method: 'post',
        payload: serialize({
            chat_id: "" + id,
            question: `Ну чё, баним ${user}?`,
            options: ["Jah", "Nein"],
            open_period: 300
        })
    });

    let payload = JSON.parse(response.getContentText()) as TLResult<Message>
    withLock(() => {
        if (payload.ok) {
            setPoll(payload.result.poll.id, payload.result.poll, user)
            let triggerId =
                ScriptApp
                    .newTrigger(handlePollTrigger.name).timeBased().after(330000)
                    .create().getUniqueId()
            PropertiesService.getScriptProperties().setProperty(triggerId, payload.result.poll.id)
        }
    })
}

function UUID() {
    return Utilities.getUuid()
}

function doGet(e) {
    const citation = getRandom();
    return HtmlService.createHtmlOutput(citation.getText());
}

class Citation {
    n: number;
    who: string;
    what: string;
    plainWhat: string;
    comment: string;
    likes: object;
    constructor(n: number, values: Array<gas.Spreadsheet.RichTextValue>) {
        this.n = n;
        this.who = values[0].getText();
        this.what = richTextToMarkdown(values[1]);
        this.plainWhat = values[1].getText();
        this.comment = values[2].getText();
        this.likes = JSON.parse(values[3].getText() || "{}");
    }

    likesCount() {
        return Object.keys(this.likes).length;
    }

    getText() {
        return `${this.what} (c) ${this.who}`;
    }

    getBtnData() {
        return {text: `${this.likesCount()} ❤`, callback_data: this.n.toString()};
    }

    send(id) {
        sendText(id, this.getText(), this.getBtnData(), "Markdown");
    }
}

function getRandom(): Citation {
    var max = getCitationSheet().getLastRow() - 1;
    var random = Math.floor(Math.random() * max) + 2;
    var range = getCitationSheet().getRange(random, 1, 1, 4);
    return new Citation(random, range.getRichTextValues()[0]);
}

function getLast(n: number = 1): Citation[] {
    const last = getCitationSheet().getLastRow();
    n = Math.min(last, n);
    const firstRow = last - n + 1
    const range = getCitationSheet().getRange(firstRow, 1, n, 4);
    return range.getRichTextValues().map((it, ix) => new Citation(firstRow + ix, it));
}

function getById(id: number): Citation | null {
    var max = getCitationSheet().getLastRow();
    if(id <= 1 || id > max) return null;
    var range = getCitationSheet().getRange(id, 1, 1, 4);
    return new Citation(id, range.getRichTextValues()[0]);
}

function getTop(n: number = 1): Citation[] {
    const last = getCitationSheet().getLastRow();
    n = Math.min(last, n);
    const vals = getCitationSheet().getRange(`A2:D${last}`).getRichTextValues().map((it, ix) => new Citation(ix+2, it));
    return vals.sort((citation1, citation2) => citation2.likesCount() - citation1.likesCount()).slice(0, n);
}

function searchCitations(text: string): string[] {
    const last = getCitationSheet().getLastRow();
    return [...getCitationSheet().getRange(`A2:D${last}`).getRichTextValues()
        .map((it, ix) => new Citation(ix+2, it))
        .filter(citation => citation.plainWhat.toLowerCase().indexOf(text.toLowerCase()) !== -1)
        .map((citation) => `Цитата #${citation.n}:\n${citation.getText()}`)];
}

function isAllowed(id) {
    var sheet = getDataSheet();

    const first = 2;
    const last = sheet.getLastRow();

    const values = sheet.getRange(`A${first}:A${last}`).getValues();

    for(const [value] of values) if(value == id) return true;
    return false;
}

function citeOfTheDay() {
    var sheet = getDataSheet();

    var row;
    for (row = 2; row <= sheet.getLastRow(); ++row) {
        var id = +sheet.getRange(row, 1).getValue();
        if (id < 0) {
            const citation = getRandom();
            sendText(id, "Цитата дня:\n" + citation.getText(), citation.getBtnData(), "Markdown");
        }
    }
}

// this is somehow not in telegram's type definitions
interface TlUpdateFix {
    poll ?: Poll
    message ?: {
        forward_sender_name?: string
    }
}

type TlUpdate = tl.Update & TlUpdateFix;
type Message = TlUpdate['message']

function getForwardedName(m: Message): string | null {
    if(m.forward_from) {
        return m.forward_from.first_name || m.forward_from.last_name || m.forward_from.username
    }
    if(m.forward_sender_name) {
        return m.forward_sender_name.split(" ")[0]
    }
    if(m.forward_signature) {
        return m.forward_signature
    }
    return null
}

function COUNT_LIKES(column: string[][]) {
    var active = getCitationSheet().getLastRow();
    return column.map(it => it[0] && [Object.keys(JSON.parse(it[0])).length] || [0]).slice(0, active - 1);
}

function success(id: number) {
    const variants = [
        "Ok",
        "k",
        "Понял, принял",
        "Ладушки",
        "Принято",
        "+",
        "Ладно, ладно",
        ")",
        "👌",
        "#sticker#CAADAgAD0B8AAqKKlgEj1GXRWttPPRYE",
        "#sticker#CAADAgADaQAD4aRlBU-4f77gfg6wFgQ",
        "#sticker#CAADAgADkA0AAulVBRj7PO_rEYFLRhYE",
        "#sticker#CAADAgAD5wIAArrAlQUWBDuqQjBTVBYE",
        "#sticker#CAADAgAD0gMAAsSraAvL_RrrpopXKxYE",
        "#sticker#CAADAgADsAMAAvoLtgiYBpwYpLy1OhYE",
        "#sticker#CAADAgAD_goAAipVGAIceOHE1A-ZDRYE",
        "#sticker#CAADAgADUgADI1nODLUg_PUBd8WYFgQ",
        "#sticker#CAADAgAD8AIAArVx2ga4Ryudl_pd6BYE",
        "#sticker#CAADAgADnAADV08VCF49wTfBNSDPFgQ",
        "#sticker#CAADBAADCgEAAtDeBQABitq9tV0QVxIWBA",
        "#sticker#CAADAgADoQADSMbXDWv_X0yWfIDDFgQ",
        "#sticker#CAADBQADqgAD3HgMCHiJ-htl5pJ3FgQ",
        "#sticker#CAADBAADNQADXHLuDXgxa8XOdXcsFgQ",
        "#sticker#CAADBAADBS4AAnzugwumtbRvD4kKCRYE",
        "#sticker#CAADAgADfwIAAgk7OxMbpktijzn0mxYE",
        "#sticker#CAADAgADFQADLdJqJ6EwxGXGQvrVFgQ",
        "#sticker#CAADAgADSRwAAkKvaQABevwAAfvwwHBqFgQ",
    ];

    const ok = variants[Math.floor(Math.random() * variants.length)];

    if(ok.indexOf("#sticker#") == 0) {
        sendSticker(id, ok.replace("#sticker#", ""))
    } else sendText(id, ok, null);
}

interface ParsedCite {
    who: string
    what: string
}

function parseCite(text: string): ParsedCite | null {
    const chunks = text.replace("/cite", "").replace("(с)", "(c)").trim().split("(c)").map(it => it.trim());

    if (chunks.length != 2)
        return null;

    return {
        who: chunks[1],
        what: chunks[0]
    };
}

function newCitation(name: string, ctext: gas.Spreadsheet.RichTextValue, src: CitationSource) {
    withLock(() => {
        getCitationSheet().appendRow([
            name.trim(),
            ctext.getText(), // TODO trim???
            `by ${SIG}`,
            "{}",
            null,
            JSON.stringify(src)
        ]);
        let lastRow = getCitationSheet().getLastRow();
        getCitationSheet().getRange(`B${lastRow}`).setRichTextValue(ctext);
        updateEditableMessagesCache(src, getCitationSheet().getLastRow());
    });

}

function tryManual(text: string, id: number, messageId: number, chatId: number) {
    if (text.trim().indexOf("/cite") == 0) {
        const tryout = parseCite(text);
        if (null === tryout) {
            sendText(id, "Попробуй так: /cite Сообщение (c) Вася", null);
            return;
        }
        const {who, what} = tryout;
        success(id);

        newCitation(who, plainTextToRichText(what), {
            messageId,
            chatId,
            type: "manual"
        });
    }
}

function checkBan(message: Message): boolean {
    const banlist = getBanList()
    return message.chat.id.toString() in banlist
        || message.from.id.toString() in banlist
        || message.from.first_name in banlist
        || message.from.username in banlist
        || ("@" + message.from.username) in banlist;
}

function handleMessage(message: Message) {
    let text = message.text;
    const id = message.chat.id;

    if (!text) return;

    text = text.replace(SIG, "");

    if (text.split(" ")[0] === "/uuid") {
        text = text.replace("/uuid", "").trim()
    }

    if (text.trim() === getDataSheet().getRange(1, 1).getValue()) {
        if (isAllowed(id)) return;
        getDataSheet().appendRow([id]);
        sendText(id, "Ок, погнали", null);
        return;
    }

    if (!isAllowed(id)) {
        sendText(id, "Ты кто? Пришли мне данные ячейки A1 из таблицы 'Data' плез", null);
        return;
    }

    const [command, ...args] = text.split(RegExp('\\s+'))

    if (command.trim() === '/random') {
        let n = parseInt(args[0])
        if(n != n || n < 0) n = 1
        if(n > 30) n = 30
        for(let i = 0; i < n; ++i) {
            getRandom().send(id);
        }

        return;
    }

    if (command.trim() === '/top') {
        let n = parseInt(args[0])
        if(n != n || n < 0) n = 1
        if(n > 30) n = 30
        const tops = getTop(n)
        for(const e of tops) {
            e.send(id)
        }
        return;
    }

    if (command.trim() === '/last') {
        let n = parseInt(args[0])
        if(n != n || n < 0) n = 1
        if(n > 30) n = 30
        const lasts = getLast(n)
        for(const e of lasts) {
            e.send(id)
        }
        return;
    }

    if (command.trim() === '/ban') {
        if (checkBan(message)) {
            sendText(id, "Ты забанен, чувак, сорян", null);
            return;
        }
        const username = args.join(" ").trim()
        if (!username) {
            sendText(id, "Мамку свою забань, тестировщик хуев", null)
            return;
        }
        debug(`Trying to ban ${username}`)
        sendBanPoll(id, username)
        return;
    }

    if(command.trim() === '/chart') {
        sendPhoto(id, getCitationSheet().getCharts()[0]);
        return;
    }

    if (text.trim().indexOf('/read') === 0) {
        const cid = parseInt(text.replace('/read', '').trim());
        if (cid != cid) {
            sendText(id, "Нет такой цитаты", null);
            return;
        }
        const citation = getById(cid);
        if (!citation) {
            sendText(id, "Нет такой цитаты", null);
            return;
        }
        citation.send(id);
        return;
    }
    
    if (text.trim().indexOf('/search') === 0) {
        const min_search = 3;
        const searchText = text.replace('/search', '').trim();
        if(searchText.length < min_search) {
            sendText(id, "А поконкретнее?", null);
            return;
        }
        const citations = searchCitations(searchText);
        if (citations.length == 0) {
            sendText(id, "Нет таких цитат", null);
            return;
        }
        sendText(id, citations.join("\n\n"), null, "Markdown");
        return;
    }

    if (text.trim().indexOf('/pic') === 0) {
        const picId = text.replace('/pic', '').trim();
        const row = parseInt(picId);
        try {
            const file = (row == row) ? getFileByRow(row) : getFileByDrive(picId);
            sendPhoto(id, file);
        } catch (ex) {
            sendText(id, "Нет такого файла", null)
        }
        return;
    }

    if (text.trim().indexOf('/debug_get_em') === 0) { // TODO delete
        sendText(id, JSON.stringify(getEditableMessages()), null);
    }

    if (message.chat.type === "private") {
        if (checkBan(message)) {
            sendText(id, "Ты забанен, чувак, сорян", null);
            return;
        }
        if (!message.forward_from && !message.forward_sender_name) {
            tryManual(text, id, message.message_id, message.chat.id);
            return
        }
        var name = getForwardedName(message) || "Some guy";
        success(id);

        newCitation(name, messageToRichText(message), {
            messageId: message.message_id,
            chatId: message.chat.id,
            type: "forward"
        });
    }

    if (text.trim() === "/cite") {
        if (checkBan(message)) {
            sendText(id, "Ты забанен, чувак, сорян", null);
            return;
        }
        if (!message.reply_to_message) {
            sendText(id, "Я умею цитировать только реплаи, сорян\nМожешь зафорвардить сообщение мне в личку", null);
            return;
        }
        const rm = message.reply_to_message;
        const name = getForwardedName(rm) || rm.from.first_name || rm.from.username;
        const text = rm.text;
        if (!text) {
            if (rm.photo) {
                handlePhoto(pickPhotoSize(rm.photo), message.chat.id);
            } else {
                sendText(id, "Не", null)
            }
            return;
        }
        success(id);

        newCitation(name, messageToRichText(rm), {
            messageId: message.message_id,
            chatId: message.chat.id,
            replyTo: {
                messageId: message.reply_to_message.message_id,
                chatId: message.reply_to_message.chat.id,
            },
            type: "reply"
        });
    }

    tryManual(text, id, message.message_id, message.chat.id);
}

function handleEditedMessage(editedMessage: Message) {
    withLock(() => {
        let row = getEditableMessages()[cacheKey({
            messageId: editedMessage.message_id,
            chatId: editedMessage.chat.id
        })];

        if (!row)
            return;
        let text = editedMessage.text.replace(SIG, "");
        let tryout = parseCite(text);

        if (null === tryout) {
            return; // No way to report the error back to user
        }
        getCitationSheet().getRange(`A${row}:B${row}`).setValues([[tryout.who, tryout.what]]);
    });

}

function handleCallback(callback_query: tl.CallbackQuery) {
    const citationId = parseInt(callback_query.data);
    if(citationId != citationId) return;
    const cite = getById(citationId);
    if(cite == null) return;

    let likes: object;
    let like: any | undefined;

    withLock(() => {
        const range = getCitationSheet().getRange(citationId, 4);

        likes = JSON.parse(range.getValue() || "{}") as object;
        const userString = '' + callback_query.from.id;
        like = likes[userString];
        if(like) delete likes[userString];
        else likes[userString] = true;
        range.setValue(JSON.stringify(likes));
    });

    editMessageReplyMarkup(callback_query.message.chat.id, callback_query.message.message_id, {
        text: Object.keys(likes).length + " ❤",
        callback_data: `${citationId}`
    });
    answerCallbackQuery(callback_query.id, like? "Разлайкано =(" : "Полайкано");
}

function handlePhoto(photo: PhotoSize, id: number) {
    const [row, driveId] = saveFile(photo.file_id);
    success(id);
    sendText(id, `Картинка номер ${row}, id файла ${driveId}`, null);
}

function pickPhotoSize(photos: PhotoSize[]): PhotoSize {
    if(photos.length === 1) return photos[0];
    photos = [...photos];
    photos.sort((a, b) => b.height * b.width - a.height * a.width);
    for(const photo of photos) {
        if(photo.width * photo.height < 1000000) return photo;
    }
    return photos[0];
}

function doPost(e: DoPost) {
    debug(e.postData.contents);

    var data = JSON.parse(e.postData.contents) as TlUpdate;
    try {
        if (data.message && data.message.photo && data.message.chat.type === 'private')
            handlePhoto(pickPhotoSize(data.message.photo), data.message.chat.id);
        else if (data.message) handleMessage(data.message);
    } catch (e) {
        sendText(data.message.chat.id, "Что-то пошло не так:\n" + e.toString(), null);
    }
    if (data.edited_message) handleEditedMessage(data.edited_message);
    if (data.poll) updatePoll(data.poll)
    if (data.callback_query) handleCallback(data.callback_query);
}

interface SpreadsheetEdit {
    value: any,
    oldValue?: any,
    range: gas.Spreadsheet.Range
}

type TLResult<T> = {
    ok: true
    result: T
} | { ok: false }

function saveFile(file_id: string): [number, string] {
    const url = `${telegramUrl()}/getFile?file_id=${file_id}`;
    const response = UrlFetchApp.fetch(url);
    const fileInfo = JSON.parse(response.getContentText()) as TLResult<tl.File>;
    if(!fileInfo.ok) return;
    const fileUrl = `${telegramFileUrl()}/${fileInfo.result.file_path}`;
    const folders = DriveApp.getFoldersByName("citations");
    const folder = folders.hasNext()? folders.next() : DriveApp.createFolder("citations");
    const resFile = folder.createFile(UrlFetchApp.fetch(fileUrl));
    getPicSheet().appendRow([resFile.getName(), resFile.getId(), null]);
    const lastRow = getPicSheet().getLastRow();
    const image = getPicSheet().insertImage(resFile, 2, lastRow);
    const height = Math.min(image.getHeight(), 300);
    image.setHeight(height);
    image.setWidth(image.getInherentWidth() * (image.getHeight() / image.getInherentHeight()));
    getPicSheet().setRowHeight(lastRow, height + 2);
    return [lastRow, resFile.getId()]
}

function getFileByDrive(driveId: string) {
    return DriveApp.getFileById(driveId);
}

function getFileByRow(row: number) {
    const sheet = getPicSheet();
    return getFileByDrive(sheet.getRange(row, 2).getValue())
}

function onEdit(e: SpreadsheetEdit) {
    debug("Invalidating...");
    if (e.range.getSheet().getIndex() == getCitationSheet().getIndex()) { // TODO do we really want to use indices???
        withLock(() => {
            invalidateEditableMeessagesCache()
        })
    }
}
