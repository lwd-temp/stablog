import Base from '~/src/command/fetch/base'
import TypeTaskConfig from '~/src/type/namespace/task_config'
import PathConfig from '~/src/config/path'
import fs from 'fs'
import _ from 'lodash'
import json5 from 'json5'
import moment from 'moment'

import ApiWeibo from '~/src/api/weibo'
import ApiWeiboCom from '~/src/api/weibo_com_api'
import MMblog from '~/src/model/mblog'
import MMblogUser from '~/src/model/mblog_user'
import CommonUtil from '~/src/library/util/common'
import * as TypeWeibo from '~/src/type/namespace/weibo'
import Util from '~/src/library/util/common'
import { TypeWeiboApi_MyBlob_Item } from 'namespace/new_weibo_api_com'

/**
 * weibo.com的新Api对应的创建时间解析格式字符串
 */
const Const_Moment_Parse_Format_4_WeiboComApi = "ddd MMM DD HH:mm:ss Z YYYY"
/**
 * 重试时的等待时间
 */
const Const_Retry_Wait_Seconds = 30
/**
 * 正常执行抓取流程的等待时间
 */
const Const_Fetch_Wati_Seconds = 20

/**
 * 解析微博文章id，方便构造api, 抓取文章内容
 * @param rawUrl
 */
function getArticleId(rawUrl = '') {
  if (!rawUrl) {
    return ''
  }
  // 需要多次解析，才能将url完全解码成正常文本
  let decodeUrl = unescape(unescape(unescape(rawUrl)))
  if (!decodeUrl) {
    return ''
  }
  let rawArticleUrl = decodeUrl.split('url=')[1]
  if (!rawArticleUrl) {
    return ''
  }
  let baseArticleUrl = rawArticleUrl.split('?')[0] // url => 'https://card.weibo.com/article/m/show/id/2309404446645566701785'
  if (!baseArticleUrl) {
    return ''
  }
  let articleId = baseArticleUrl.split('show/id/')[1]
  if (!articleId) {
    return ''
  }
  return articleId
}

class FetchCustomer extends Base {
  fetchStartAtPageNo = 0
  fetchEndAtPageNo = 10000

  requestConfig = {
    st: '',
  }

  static get signature() {
    return `
        Fetch:Customer
    `
  }

  static get description() {
    return `从${PathConfig.customerTaskConfigUri}中读取自定义抓取任务并执行`
  }

  async execute(args: any, options: any): Promise<any> {
    this.log(`从${PathConfig.customerTaskConfigUri}中读取配置文件`)
    let fetchConfigJSON = fs.readFileSync(PathConfig.customerTaskConfigUri).toString()
    this.log('content =>', fetchConfigJSON)
    let customerTaskConfig: TypeTaskConfig.Customer = json5.parse(fetchConfigJSON)
    this.fetchStartAtPageNo = customerTaskConfig.fetchStartAtPageNo || this.fetchStartAtPageNo
    this.fetchEndAtPageNo = customerTaskConfig.fetchEndAtPageNo || this.fetchEndAtPageNo
    if (customerTaskConfig.isSkipFetch) {
      this.log(`检测到isSkipFetch配置为${!!customerTaskConfig.isSkipFetch}, 自动跳过抓取流程`)
      return
    }
    this.log(`开始进行自定义抓取`)
    type TypeTaskPackage = {
      [key: string]: Array<string>
    }
    let taskConfigList: Array<TypeTaskConfig.Record> = customerTaskConfig.configList

    // 记录通过新微博获取的用户微博记录, 方便后续转换出创建时间戳
    let newApiFormatRecordMap = new Map<string, TypeWeiboApi_MyBlob_Item>()
    // 记录Api V2 已抓取页面列表
    let newApiFetchPageSet = new Set<number>()
    for (let taskConfig of taskConfigList) {
      let { uid, comment } = taskConfig
      this.log(`待抓取用户uid => ${uid}`)
      this.log(`备注信息 => ${comment}`)
      // 开工
      this.log(`抓取用户${uid}信息`)
      let response = await ApiWeibo.asyncGetUserInfoResponseData(uid)
      if (_.isEmpty(response)) {
        this.log(`用户信息获取失败, 请检查登录状态`)
        continue
      }
      let userInfo = response.userInfo
      this.log(`用户信息获取完毕,待抓取用户为:${userInfo.screen_name},个人简介:${userInfo.description}`)
      // 拿到containerId
      let containerId: string = ''
      for (let tab of response.tabsInfo.tabs) {
        if (tab.tabKey === 'weibo') {
          containerId = tab.containerid
        }
      }
      if (containerId === '') {
        this.log(`未能获取到用户${userInfo.screen_name}对应的containerId,自动跳过`)
        continue
      }
      this.log(`开始抓取用户${userInfo.screen_name}微博记录`)
      let mblogCardList = await ApiWeibo.asyncGetWeiboList(uid).catch(e => {
        // 避免crash导致整个进程退出
        return []
      })
      if (_.isEmpty(mblogCardList)) {
        this.log(`用户${userInfo.screen_name}微博记录为空,跳过抓取流程`)
        continue
      }
      let mblogCard = mblogCardList[0]
      let mblog = mblogCard.mblog
      let mblogUserInfo = mblog.user
      // 保存用户信息
      await MMblogUser.replaceInto({
        author_uid: `${mblogUserInfo.id}`,
        raw_json: JSON.stringify(mblogUserInfo),
      })
      // 用户总微博数
      let totalMblogCount = await ApiWeibo.asyncGetWeiboCount(uid)
      let totalPageCount = Math.ceil(totalMblogCount / 10)
      this.log(`用户${userInfo.screen_name}共发布了${totalMblogCount}条微博, 正式开始抓取`)
      let maxFetchPageNo = this.fetchEndAtPageNo <= totalPageCount ? this.fetchEndAtPageNo : totalPageCount
      this.log(`本次抓取的页码范围为:${this.fetchStartAtPageNo}~${maxFetchPageNo}`)
      // 为抓取微博自定义一套流程
      // 获取st
      this.requestConfig.st = await ApiWeibo.asyncStep1FetchPageConfigSt()
      // 拿着st, 获取api config中的st
      this.requestConfig.st = await ApiWeibo.asyncStep2FetchApiConfig(this.requestConfig.st)

      for (let page = 1; page <= totalPageCount; page++) {
        if (page < this.fetchStartAtPageNo) {
          page = this.fetchStartAtPageNo
          this.log(`从第${this.fetchStartAtPageNo}页数据开始抓取`)
        }
        if (page > this.fetchEndAtPageNo) {
          this.log(`已抓取至设定的第${page}/${this.fetchEndAtPageNo}页数据, 自动跳过抓取`)
        } else {
          // 先通过新接口抓取微博记录, 储存在newApiFormatRecordMap中, 方便后续解析创建时间
          // .com系列接口一次返回20条数据, 所以实际需要抓取的页数比页数少一半
          //  页面页码需要缓存住, 以避免出现从非0页开始抓取的情况
          let pageApiV2 = Math.floor(page / 2)
          if (newApiFetchPageSet.has(pageApiV2) === false) {
            let newApiFormatRecordList = await ApiWeiboCom.asyncStep3GetWeiboList(uid, pageApiV2).catch(e => { return [] })
            if (newApiFormatRecordList.length === 0) {
              // 说明抓取失败, 等待30s后重试一次
              this.log(`经ApiV2接口抓取第${page}~${page + 1}页数据失败(1/3), 等待${Const_Retry_Wait_Seconds}s后重试`)
              await Util.asyncSleep(1000 * Const_Retry_Wait_Seconds)
              newApiFormatRecordList = await ApiWeiboCom.asyncStep3GetWeiboList(uid, pageApiV2)
            }
            if (newApiFormatRecordList.length === 0) {
              this.log(`经ApiV2接口抓取第${page}~${page + 1}页数据失败(2/3), 等待${Const_Retry_Wait_Seconds}s后重试`)
              await Util.asyncSleep(1000 * Const_Retry_Wait_Seconds)
              newApiFormatRecordList = await ApiWeiboCom.asyncStep3GetWeiboList(uid, pageApiV2)
            }
            if (newApiFormatRecordList.length === 0) {
              this.log(`经ApiV2接口抓取第${page}~${page + 1}页数据失败(3/3), 跳过该页的抓取`)
            } else {
              // 抓取成功则备份之
              newApiFetchPageSet.add(pageApiV2)
            }

            for (let newApiFormatRecord of newApiFormatRecordList) {
              newApiFormatRecordMap.set(`${newApiFormatRecord.id}`, newApiFormatRecord)
            }
          }


          await this.fetchMblogListAndSaveToDb(uid, page, totalPageCount, newApiFormatRecordMap)
          // 微博的反爬虫措施太强, 只能用每20s抓一次的方式拿数据🤦‍♂️
          this.log(`已抓取${page}/${totalPageCount}页记录, 休眠${Const_Fetch_Wati_Seconds}s, 避免被封`)
          await Util.asyncSleep(Const_Fetch_Wati_Seconds * 1000)
        }
      }
      this.log(`用户${userInfo.screen_name}的微博数据抓取完毕`)
    }
    this.log(`所有任务抓取完毕`)
  }

  /**
   * 
   * @param author_uid 
   * @param page 
   * @param totalPage 
   * @param newFormatRecordMap 
   */
  async fetchMblogListAndSaveToDb(author_uid: string, page: number, totalPage: number, newFormatRecordMap: Map<string, TypeWeiboApi_MyBlob_Item>) {
    let target = `第${page}/${totalPage}页微博记录`
    this.log(`准备抓取${target}`)
    let rawMblogList = await ApiWeibo.asyncStep3GetWeiboList(this.requestConfig.st, author_uid, page).catch(e => {
      // 避免crash导致整个进程退出
      return []
    })
    if (rawMblogList.length === 0) {
      // 说明抓取失败, 等待30s后重试一次
      this.log(`经ApiV1接口抓取第${page}/${totalPage}页数据失败(1/3), 等待${Const_Retry_Wait_Seconds}s后重试`)
      await Util.asyncSleep(1000 * Const_Retry_Wait_Seconds)
      // 更新st
      let newSt = await ApiWeibo.asyncStep2FetchApiConfig(this.requestConfig.st)
      this.requestConfig.st = newSt
      // 带着新st重新抓取一次
      rawMblogList = await ApiWeibo.asyncStep3GetWeiboList(this.requestConfig.st, author_uid, page)
    }
    if (rawMblogList.length === 0) {
      this.log(`经ApiV1接口抓取第${page}/${totalPage}页数据失败(2/3), 等待${Const_Retry_Wait_Seconds}s后重试`)
      await Util.asyncSleep(1000 * Const_Retry_Wait_Seconds)
      rawMblogList = await ApiWeibo.asyncStep3GetWeiboList(this.requestConfig.st, author_uid, page)
    }
    if (rawMblogList.length === 0) {
      this.log(`经ApiV1接口抓取第${page}/${totalPage}页数据失败(3/3), 跳过对本页的抓取`)
      await Util.asyncSleep(1000 * Const_Retry_Wait_Seconds)
      return
    }
    let mblogList: Array<TypeWeibo.TypeMblog> = []

    // 此处要根据微博类型进行具体定制
    for (let rawMblog of rawMblogList) {
      let mblog = rawMblog.mblog
      if (_.isEmpty(mblog) || _.isEmpty(mblog.user)) {
        // 数据为空自动跳过
        continue
      }

      // 检查是否是长微博
      if (rawMblog.mblog.isLongText === true) {
        // 长微博需要调取api重新获得微博内容
        let bid = rawMblog.mblog.bid
        let realMblog = <TypeWeibo.TypeMblog>await ApiWeibo.asyncGetLongTextWeibo(bid).catch(e => {
          // 避免crash导致整个进程退出
          return {}
        })
        if (_.isEmpty(realMblog)) {
          continue
        }
        // @ts-ignore
        mblog = realMblog
      }
      if (_.isEmpty(rawMblog.mblog.retweeted_status) == false && rawMblog.mblog.retweeted_status !== undefined) {
        if (rawMblog.mblog.retweeted_status.isLongText === true) {
          // 转发微博属于长微博
          let bid = rawMblog.mblog.retweeted_status.bid
          let realRetweetMblog = <TypeWeibo.TypeMblog>await ApiWeibo.asyncGetLongTextWeibo(bid)
          mblog.retweeted_status = realRetweetMblog
        }
        if (
          rawMblog.mblog.retweeted_status !== undefined &&
          rawMblog.mblog.retweeted_status.page_info !== undefined &&
          rawMblog.mblog.retweeted_status.page_info.type === 'article'
        ) {
          // 转发的是微博文章
          let pageInfo = rawMblog.mblog.retweeted_status.page_info
          let articleId = getArticleId(pageInfo.page_url)
          let articleRecord = await ApiWeibo.asyncGetWeiboArticle(articleId).catch(e => {
            // 避免crash导致整个进程退出
            return {}
          })
          if (_.isEmpty(articleRecord)) {
            // 文章详情获取失败, 不储存该记录
            continue
          }
          mblog.retweeted_status.article = articleRecord
        }
      }
      if (rawMblog.mblog.page_info && rawMblog.mblog.page_info.type === 'article') {
        // 文章类型为微博文章
        let pageInfo = rawMblog.mblog.page_info
        let articleId = getArticleId(pageInfo.page_url)
        let articleRecord = await ApiWeibo.asyncGetWeiboArticle(articleId).catch(e => {
          // 避免crash导致整个进程退出
          return {}
        })
        if (_.isEmpty(articleRecord)) {
          // 文章详情获取失败, 不储存该记录
          continue
        }
        mblog.article = articleRecord
      }
      mblogList.push(mblog)
    }

    this.log(`${target}抓取成功, 准备存入数据库`)
    for (let mblog of mblogList) {
      // 处理完毕, 将数据存入数据库中
      let id = mblog.id
      let author_uid = `${mblog.user.id}`
      let idStr = `${id}`
      let createAt = 0
      // 优先从新Api记录中查阅
      if (newFormatRecordMap.has(idStr) && newFormatRecordMap.get(idStr)?.created_at) {
        let newFormatRecord = newFormatRecordMap.get(idStr)
        let createTimeFormatStr = newFormatRecord?.created_at || ''
        let createAtMoment = moment(createTimeFormatStr, Const_Moment_Parse_Format_4_WeiboComApi)
        createAt = createAtMoment.unix()
        // 解析出正确时间后, 将原数据替换为标准时间
        mblog.created_at = createAtMoment.format("YYYY-MM-DD HH:mm:ss")
      } else {
        createAt = this.parseMblogCreateTimestamp(mblog)
      }
      mblog.created_timestamp_at = createAt
      let raw_json = JSON.stringify(mblog)
      // 这里可能会出报SQLITE_BUSY: database is locked 
      await MMblog.replaceInto({
        id,
        author_uid,
        raw_json,
        post_publish_at: mblog.created_timestamp_at,
      }).catch((e: Error) => {
        this.log("数据库插入出错 => ", {
          name: e?.name,
          message: e?.message,
          stack: e?.stack
        })
        return
      })
    }
    this.log(`${target}成功存入数据库`)
  }

  /**
   * 简单将微博发布时间解析为
   * @param mlog
   */
  parseMblogCreateTimestamp(mlog: TypeWeibo.TypeMblog) {
    let rawCreateAtStr = `${mlog.created_at}`
    if (rawCreateAtStr.includes('-') === false) {
      // Mon Sep 16 01:13:45 +0800 2019
      if (rawCreateAtStr.includes('+0800')) {
        // 'Sun Sep 15 00:35:14 +0800 2019' 时区模式
        return moment(new Date(rawCreateAtStr)).unix()
      }
      // '12小时前' | '4分钟前' | '刚刚' | '1小时前' 模式
      // 不含-符号, 表示是最近一天内, 直接认为是当前时间, 不进行细分
      return moment().unix()
    }
    if (rawCreateAtStr.length === '08-07'.length) {
      // 月日模式, 表示当前年份,手工补上年份
      return moment(`${moment().format('YYYY')}-${rawCreateAtStr}`).unix()
    }
    // 否则, 为'2012-01-02'  模式, 直接解析即可
    return moment(rawCreateAtStr).unix()
  }
}

export default FetchCustomer
