import promiseRetry from 'promise-retry';
import PQueue from 'p-queue';
import * as XMLRPC from 'xmlrpc';
import { WKUser } from './index';

const WikidotAJAX = require('wikidot-ajax');

const RETRIES = 4;

const rpcQueue = new PQueue({ concurrency: 4 });
const ajaxQueue = new PQueue({ concurrency: 8 });

interface LoggerFn {
  (message: string, type?: string, any?: Object): void;
}

export interface WKUser {
  uid: number;
  username?: string;
  deleted?: boolean;
  about?: string;
  userSince?: Date;
  memberSince?: Date;
}

export interface WKPage {
  fullname: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  title: string;
  title_shown: string;
  tags: string[];
  rating: number;
  revisions: number;
  content: string;
  html: string;
  children: number;
  comments: number;
  commented_at: string;
  commented_by: string;
}

export interface WKPageRevisionMeta {
  id: number;
  number: number;
  uid: number;
  date: Date;
  description: string;
}

export interface WKUserVote {
  uid: number;
  vote: string;
}

class WikidotKit {
  static version: string;

  xmlrpc: XMLRPC.Client;

  logger?: LoggerFn;

  constructor(token: string, logger?: LoggerFn) {
    if (!token) {
      throw new Error('token is required');
    }

    if (logger) {
      this.logger = logger;
    }

    this.xmlrpc = XMLRPC.createSecureClient({
      host: 'www.wikidot.com',
      port: 443,
      path: '/xml-rpc-api.php',
      basic_auth: {
        user: `WikidotKit v${WikidotKit.version}`,
        pass: token,
      },
    });
  }

  log(message: string, extra?: any) {
    if (this.logger) {
      this.logger(message, extra);
    }
  }

  logError(message: string, extra?: any) {
    if (this.logger) {
      this.logger(message, 'error', extra);
    }
  }

  call(method: string, args: Object): Promise<any> {
    return rpcQueue.add(() => promiseRetry((retry: any) => new Promise((resolve, reject) => {
      this.log('rpcCall', { method, args });
      this.xmlrpc.methodCall(method, [args], (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    }).catch(retry), { retries: RETRIES }));
  }

  ajaxCall(wikiUrl: string, args: Object) {
    const query = new WikidotAJAX({ baseURL: wikiUrl });

    return ajaxQueue.add(() => promiseRetry((retry: any) => {
      this.log('ajaxCall', { wikiUrl, args });
      return query(args).catch(retry);
    }, { retries: RETRIES }));
  }

  fetchPagesList(wiki: string): Promise<string[]> {
    return this.call('pages.select', { site: wiki });
  }

  fetchPage(wiki: string, name: string) {
    return this.call('pages.get_one', { site: wiki, page: name });
  }

  async fetchMembersList(wikiUrl: string): Promise<WKUser[]> {
    this.log('fetchMembersList', { wikiUrl });

    const membersPage: any = await this.ajaxCall(wikiUrl, {
      moduleName: 'membership/MembersListModule',
    });

    const totalPages = parseInt(membersPage('.pager .target:nth-last-child(2)').text(), 10);
    const pages = Array.from({ length: totalPages }, (_, i) => i);

    this.log('fetchMembersList total pages', { wikiUrl, totalPages });

    const fetchMembersPage = async (pageNumber: number): Promise<WKUser[]> => {
      this.log('fetchMembersPage', { wikiUrl, pageNumber });

      const $: any = await this.ajaxCall(wikiUrl, {
        moduleName: 'membership/MembersListModule',
        page: pageNumber,
      });
      return Array.from($('.printuser a:last-of-type')).map((elem) => {
        const jqElem = $(elem);
        return {
          username: jqElem.text(),
          uid: Number(jqElem.attr('onclick').replace(/.*\((.*?)\).*/, '$1')),
        };
      });
    };

    const userLists = await Promise.all(pages
      .map(pageNumber => fetchMembersPage(pageNumber)));

    const fullUserList = userLists
      .reduce((allUsers, pageOfUsers) => allUsers.concat(pageOfUsers), []);

    this.log('fetchMembersList full list is ready');

    return Promise.all(fullUserList.map(({ uid }: WKUser) => this.fetchUserProfile(wikiUrl, uid)));
  }

  async fetchUserProfile(wikiUrl: string, uid: number): Promise<WKUser> {
    this.log('fetchUserProfile', { wikiUrl, uid });

    const $: any = await this.ajaxCall(wikiUrl, {
      moduleName: 'users/UserInfoWinModule',
      user_id: uid,
    });

    const username = $('h1').text();
    const about = $('.table tr em').text();
    const date = $('.table tr .odate');
    const userSince = new Date($(date[0]).text());
    const memberSince = new Date($(date[1]).text());

    if (username.length) {
      return {
        uid, username, about, userSince, memberSince,
      };
    }
    return { uid, deleted: true };
  }
}

WikidotKit.version = require('../package.json').version;

export default WikidotKit;
