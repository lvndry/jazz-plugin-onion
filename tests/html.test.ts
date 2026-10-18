import { describe, expect, it } from "bun:test";
import {
  decodeEntities,
  hiddenFormFields,
  htmlToText,
  onionLinks,
  pageTitle,
  parseAhmiaResults,
} from "../src/html";

const ONION = "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";
const OTHER_ONION = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#x27; &bogus;")).toBe(
      "a & b <c> 'd' &bogus;",
    );
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles and the head, keeping block structure", () => {
    const html = `<html><head><title>T</title><style>p{}</style></head><body>
      <script>alert(1)</script><h1>Heading</h1><p>First   para</p><div>Second<br>line</div></body></html>`;
    expect(htmlToText(html)).toBe("Heading\nFirst para\nSecond\nline");
  });
});

describe("pageTitle", () => {
  it("reads and cleans the title", () => {
    expect(pageTitle("<title> A &amp; B </title>")).toBe("A & B");
    expect(pageTitle("<p>no title</p>")).toBe("");
  });
});

describe("onionLinks", () => {
  it("resolves relative links and keeps only onion hosts", () => {
    const html = `<a href="/about">About</a><a href='http://${OTHER_ONION}/x#frag'>Other</a>
      <a href="https://example.com">Clear</a><a href="/about">Dup</a><a href="mailto:x@y">Mail</a>`;
    expect(onionLinks(html, `http://${ONION}/index`)).toEqual([
      { text: "About", url: `http://${ONION}/about` },
      { text: "Other", url: `http://${OTHER_ONION}/x` },
    ]);
  });
});

describe("hiddenFormFields", () => {
  it("collects hidden inputs only", () => {
    const html = `<form action="/search/"><input type="text" name="q">
      <input type="hidden" name="e4c1d2" value="7f3a9b"><input name="other" type='HIDDEN' value=''></form>`;
    expect(hiddenFormFields(html)).toEqual([
      ["e4c1d2", "7f3a9b"],
      ["other", ""],
    ]);
  });
});

describe("parseAhmiaResults", () => {
  it("unwraps Ahmia's redirect links and reads titles and snippets", () => {
    const html = `<ol class="searchResults">
      <li class="result">
        <h4><a href="/search/redirect?search_term=news&amp;redirect_url=http://${OTHER_ONION}/">Some &amp; Title</a></h4>
        <p>A <b>snippet</b> here.</p>
        <cite>${OTHER_ONION}</cite>
      </li>
      <li class="result"><h4><a href="http://${ONION}/direct">Direct</a></h4></li>
    </ol>`;
    expect(parseAhmiaResults(html, `http://${ONION}/search/?q=news`)).toEqual([
      { title: "Some & Title", url: `http://${OTHER_ONION}/`, snippet: "A snippet here." },
      { title: "Direct", url: `http://${ONION}/direct`, snippet: "" },
    ]);
  });

  it("returns nothing for a page without results", () => {
    expect(parseAhmiaResults("<p>No results</p>", `http://${ONION}/`)).toEqual([]);
  });
});
