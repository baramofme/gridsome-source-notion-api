const YAML = require("yaml")
const fetch = require("node-fetch")
const {errorMessage} = require("./error-message")
const { pipeExtend } = require("or-pipets")

class NotionAPIPlugin {

    static defaultOptions() {
        return {
            notionVersion: "2021-05-13",
            token: undefined,
            databaseId: undefined,
            propsToFrontmatter: true,
            lowerTitleLevel: true,
            notionNodeType: 'NotionRecords'
        }
    }

    constructor(api, options) {

        api.loadSource(async actions => {
            const notionRecords = actions.addCollection(options.notionNodeType)

            const pages = await this.getPages(options)
            pages.forEach((page) => {
                const title = this.getNotionPageTitle(page)
                const properties = this.getNotionPageProperties(page)
                let markdown = this.notionBlockToMarkdown(page, options.lowerTitleLevel)

                if (options.propsToFrontmatter) {
                    const frontmatter = Object.keys(properties).reduce(
                        (acc, key) => ({
                            ...acc,
                            [key]: properties[key].value.remoteImage || properties[key].value,
                        }),
                        {title},
                    )

                    markdown = "---\n".concat(YAML.stringify(frontmatter)).concat("\n---\n\n").concat(markdown)
                }

                notionRecords.addNode({
                    id: `${options.notionNodeType}-${page.id}`, // 넣지 않으면 자동 생성되는데 이게 꼭 필요한 건지 모르겠다.
                    title,
                    properties,
                    archived: page.archived,
                    createdAt: page.created_time,
                    updatedAt: page.last_edited_time,
                    markdownString: markdown,
                    raw: page,
                    json: JSON.stringify(page),
                })
            })

        })
    }

    async getPages({token, databaseId, notionVersion}) {
        let hasMore = true
        let startCursor = ""
        const url = `https://api.notion.com/v1/databases/${databaseId}/query`
        const body = {
            page_size: 100,
        }

        const pages = []

        while (hasMore) {
            if (startCursor) {
                body.start_cursor = startCursor
            }

            try {

                const result = await fetch(url, {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: {
                        "Content-Type": "application/json",
                        "Notion-Version": notionVersion,
                        Authorization: `Bearer ${token}`,
                    },
                }).then((res) => res.json())


                startCursor = result.next_cursor
                hasMore = result.has_more

                for (let page of result.results) {
                    page.children = await this.getBlocks({id: page.id, token, notionVersion})

                    pages.push(page)
                }
            } catch (e) {
                console.log(errorMessage)
            }
        }

        return pages
    }

    async getBlocks({ id, notionVersion, token }){
        let hasMore = true
        let blockContent = []
        let startCursor = ""

        while (hasMore) {
            let url = `https://api.notion.com/v1/blocks/${id}/children`

            if (startCursor) {
                url += `?start_cursor=${startCursor}`
            }

            try {
                const result = await fetch(url, {
                    headers: {
                        "Content-Type": "application/json",
                        "Notion-Version": notionVersion,
                        Authorization: `Bearer ${token}`,
                    },
                }).then((res) => res.json())

                for (let childBlock of result.results) {
                    if (childBlock.has_children) {
                        childBlock.children = await this.getBlocks(
                            { id: childBlock.id, notionVersion, token }
                        )
                    }
                }

                // 해석하지 않고 누적한다.
                blockContent = blockContent.concat(result.results)
                startCursor = result.next_cursor
                hasMore = result.has_more
            } catch (e) {
                console.log(errorMessage)
            }
        }

        return blockContent
    }

    getNotionPageProperties(page){
        return Object.keys(page.properties).reduce((acc, key) => {
            // 제목 타입은 처리하지 않음
            if (page.properties[key].type == "title") {
                return acc
            }

            if (page.properties[key].type == "rich_text") {
                page.properties[key].rich_text = blockToString(page.properties[key].rich_text)
            }

            return {
                ...acc,
                [key]: {
                    id: page.properties[key].id,
                    key,
                    value: page.properties[key][page.properties[key].type],
                    type: page.properties[key].type,
                },
            }
        }, {})
    }

    blockToString(textBlocks) {
        return textBlocks.reduce((text, textBlock) => {
            const data = {
                ...textBlock.text,
                ...textBlock.annotations,
            }

            if (textBlock.type == "equation") {
                data.content = textBlock.equation.expression
                data.equation = true
            }

            if (textBlock.type == "mention") {
                if (textBlock.mention.type == "user") {
                    data.content = textBlock.plain_text
                }

                if (textBlock.mention.type == "date") {
                    if (textBlock.mention.date.end) {
                        data.content = `${textBlock.mention.date.start} → ${textBlock.mention.date.start}`
                    } else {
                        data.content = textBlock.mention.date.start
                    }

                    data.content = `<time datetime="${data.content}">${data.content}</time>`
                }

                if (textBlock.mention.type == "page") {
                    data.content = textBlock.plain_text
                }
            }
            return text.concat(this.stylize.process(data).content)
        }, "")
    }

    getNotionPageTitle(page) {
        const titleProperty = Object.keys(page.properties).find(
            (key) => page.properties[key].type == "title",
        )
        return this.blockToString(page.properties[titleProperty].title)
    }

    notionBlockToMarkdown = (block, lowerTitleLevel, depth = 0) =>
        // 블록이 담긴 children 배열을 처리하면서 결과를 누적
        block.children.reduce((acc, childBlock) => {
            let childBlocksString = ""

            // 블록이 또다른 블록을 하위로 가지고 있으면 재귀 호출, 콜스택이 끝나다 다음으로 넘어기 때문에. 자식 의 자식 의 자식을 다 붙이게 됨
            if (childBlock.has_children) {
                childBlocksString = "  "
                    // depth 갯수만큼 빈간 두개를 생성, 마크다운 들여쓰기 형식 적용
                    .repeat(depth)
                    .concat(childBlocksString)
                    .concat(this.notionBlockToMarkdown(childBlock, lowerTitleLevel, depth + 2))
                    .concat(this.EOL_MD)
            }

            if (childBlock.type == "paragraph") {
                const p = this.blockToString(childBlock.paragraph.text)

                // 테이블 행인지
                const isTableRow = p.startsWith("|") && p.endsWith("|")

                // 코드 스니펫 줄인지
                const isCodeSnippetLine =
                    block.paragraph &&
                    block.paragraph.text &&
                    block.paragraph.text[0] &&
                    block.paragraph.text[0].plain_text &&
                    block.paragraph.text[0].plain_text.startsWith("```")

                // 누적
                return acc
                    // 내용물을 붙여 넣은 뒤에
                    .concat(p)
                    // 테이블 행이나 코드 스니펫 라인이면 줄바꿈 코드를 넣기
                    .concat(isTableRow || isCodeSnippetLine ? this.EOL_MD : this.EOL_MD.concat(this.EOL_MD))
                    // 두간 띄우기.. 이건 왜 넣지?
                    .concat(childBlocksString)
            }

            // 헤딩으로 시작하면 레벨을 추출한 뒤에
            if (childBlock.type.startsWith("heading_")) {
                const headingLevel = Number(childBlock.type.split("_")[1])

                // 마크다운 헤딩 적용하기
                return acc
                    .concat(this.EOL_MD)
                    // 제목라벨 단계 낮추는 거 있으면 한단계 낮추기
                    .concat(lowerTitleLevel ? "#" : "")
                    .concat("#".repeat(headingLevel))
                    .concat(" ")
                    .concat(this.blockToString(childBlock[childBlock.type].text))
                    .concat(this.EOL_MD) // 줄바꾸고
                    .concat(childBlocksString)
            }

            if (childBlock.type == "to_do") {
                return acc
                    .concat(`- [${childBlock.to_do.checked ? "x" : " "}] `)
                    .concat(this.blockToString(childBlock.to_do.text))
                    .concat(this.EOL_MD)
                    .concat(childBlocksString)
            }

            if (childBlock.type == "bulleted_list_item") {
                return acc
                    .concat("* ")
                    .concat(this.blockToString(childBlock.bulleted_list_item.text))
                    .concat(this.EOL_MD)
                    .concat(childBlocksString)
            }

            if (childBlock.type == "numbered_list_item") {
                return acc
                    .concat("1. ")
                    .concat(this.blockToString(childBlock.numbered_list_item.text))
                    .concat(this.EOL_MD)
                    .concat(childBlocksString)
            }

            if (childBlock.type == "toggle") {
                return acc
                    .concat("<details><summary>")
                    .concat(this.blockToString(childBlock.toggle.text))
                    .concat("</summary>")
                    .concat(childBlocksString)
                    .concat("</details>")
            }

            if (childBlock.type == "unsupported") {
                return acc
                    .concat(`<!-- This block is not supported by Notion API yet. -->`)
                    .concat(this.EOL_MD)
                    .concat(childBlocksString)
            }

            // 누적한 거 리턴
            return acc
        }, "")

    get EOL_MD() {
        return "\n"
    }


    get stylize(){

        const pick = (key) => (obj) => obj[key]

        const ifTrue = (predicate, transformer, orElse) => (data) =>
            predicate(data) ? transformer(data) : orElse(data)

        const returnOrigin = (x) => x

        const annotateEquation = ifTrue(
            pick("equation"),
            ({ content }) => ({ content: `$${content}$` }),
            returnOrigin,
        )

        const annotateBold = ifTrue(pick("bold"), ({ content }) => ({ content: `**${content}**` }), returnOrigin)
        const annotateItalic = ifTrue(pick("italic"), ({ content }) => ({ content: `_${content}_` }), returnOrigin)
        const annotateCode = ifTrue(pick("code"), ({ content }) => ({ content: `\`${content}\`` }), returnOrigin)
        const annotateStrikethrough = ifTrue(
            pick("strikethrough"),
            ({ content }) => ({ content: `~~${content}~~` }),
            returnOrigin,
        )
        const annotateUnderline = ifTrue(
            pick("underline"),
            ({ content }) => ({ content: `<u>${content}</u>` }),
            returnOrigin,
        )
        const annotateColor = ifTrue(
            ({ color }) => color != "default",
            ({ content, color }) => ({ content: `<span notion-color="${color}">${content}</span>` }),
            returnOrigin,
        )
        const annotateLink = ifTrue(
            pick("link"),
            ({ content, link }) => ({ content: `[${content}](${link.url ? link.url : link})` }),
            returnOrigin,
        )

        return pipeExtend(annotateBold)
            .pipeExtend(annotateItalic)
            .pipeExtend(annotateCode)
            .pipeExtend(annotateStrikethrough)
            .pipeExtend(annotateUnderline)
            .pipeExtend(annotateColor)
            .pipeExtend(annotateLink)
            .pipeExtend(annotateEquation)
    }


}

module.exports = NotionAPIPlugin