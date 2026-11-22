# Making the ad-blocked visit pay, without making the reader mad

## Why the adblock walls died (short)

- **Readers leave instead of whitelisting.** A wall turns a free visit into a decision, and most people decide to close the tab. The publisher loses the page view, the share, the link and the habit, and earns nothing from the blocked visit anyway.
- **SEO is not the direct reason.** Googlebot does not run an ad blocker, so it never sees the wall. The damage is indirect: fewer shares, fewer backlinks, worse engagement signals.
- **Legal grey zone in the EU.** Detecting an ad blocker means reading state from the device, which arguably needs consent under ePrivacy Art. 5(3). The BGH ("Werbeblocker II", 2018) also confirmed that ad blockers are legal, so publishers lost the fight on that front.
- **Germany moved on to "pay or okay"** (Pur-Abo): accept tracking or pay. That handles consent, but blocker users click "accept" and still block.

So the design target: revenue that a blocker does not remove by default, that a reader does not resent enough to write a filter rule for, and that stays clearly labelled (§22 MStV, Pressekodex Ziffer 7, UWG §5a).

## How an ad blocker actually sees a page

1. **Network filters**: block requests to known ad and tracking domains (doubleclick, criteo, ...). Anything served from a third-party ad stack dies here.
2. **Cosmetic filters**: hide elements by selector (`.ad-slot`, `[id^=google_ads]`) or, in uBlock Origin, by text (`:has-text(Anzeige)`).
3. **Site-specific rules**: someone writes a rule for your site because something on it annoyed them.

Plain first-party text, server-rendered inside the article flow, survives 1 and 2 by default. Only 3 can kill it, and 3 only happens if it is worth someone's effort. Annoyance is the attack surface.

## The ideas (48)

### A. Inside the article itself

1. **Sponsor line.** "This explainer is made possible by X." One labelled sentence, server-rendered, no tracking. Seen by 100 % of readers.
2. **Classified text ads.** One line at the end of an article, like the old newspaper Kleinanzeigen: "Anzeige: Bäckerei Huber, Sendling, frische Brezn ab 6 Uhr." Self-serve booking, topic and region targeting, flat price.
3. **Sponsor of the week, editor-written.** The Daring Fireball model: one sponsor per week, the newsroom writes a short honest intro, it appears in the article footer and the feed. Premium price, high trust.
4. **Sponsored data box.** "The numbers" infobox in the article, presented by a brand that fits (a data provider, an insurer for a weather story).
5. **Sponsored glossary.** Explanations of jargon in the text carry a small "Erklärt mit X" credit.
6. **Affiliate links in service journalism.** Product tests and buying guides earn commission. Links are plain links; blockers rarely touch them. Wirecutter scale.
7. **Comparison calculator.** Electricity, loans, car insurance calculators inside service articles, paid per lead. Huge in German media already.
8. **Topic-matched job listings.** A three-line jobs box under a story about the industry it covers.
9. **Local listings.** Real estate, events, openings matched to the district a local story is about.
10. **Sponsored chart.** The interactive graphic carries "presented by" in its caption.
11. **Sponsored summary box.** The tl;dr at the top of long reads carries a one-word sponsor credit.
12. **Sponsor in the infographic image.** The logo is part of the image file. Unblockable, but close to editorial mixing.
13. **Sponsored quiz.** "Test your knowledge" at the end, presented by a brand.
14. **Brand-funded series.** A foundation or company funds a whole beat with editorial independence (the Guardian global development model).
15. **Advertorial link in text.** A labelled link from the article into a native advertorial page.
16. **Sponsored read-aloud.** The audio version opens with a ten-second host-read spot, served from the publisher's own domain.
17. **Sponsored debate section.** The comment or debate area under the article is presented by a sponsor.
18. **Sponsored newsletter teaser.** A box in the article: "Get the morning briefing, presented by X." Sponsor revenue now, plus a reader moved into a blocker-free channel.

### B. Move the reader to a channel where blockers do not work

19. **Newsletter capture for blocker users.** Detect nothing; just offer the newsletter well. Ads in email are not blocked.
20. **Podcast funnel.** Host-read audio ads cannot be filtered. Push blocker readers toward the podcast.
21. **Free login instead of ads.** Logged-in readers are worth more: first-party data, contextual targeting, email.
22. **App funnel.** In-app ads are blocked far less often than browser ads.
23. **Sponsored RSS items.** One sponsor post per week in the feed, clearly labelled.

### C. Ask for something other than ad views

24. **Contribution ask.** The Guardian model, shown to everyone, worded for people who block.
25. **Google Ad Manager offerwall.** Already exists: reader picks micropayment, survey, rewarded ad or newsletter signup to continue.
26. **Opinion poll widget.** Civey-style: the reader answers one question, sees the result, the publisher earns per answer.
27. **Market research question.** One survey question unlocks the article (the old Google Surveys idea).
28. **Micropayment per article.** Blendle, Laterpay, Supertab. Never scaled.
29. **Day pass.** One euro for 24 hours ad-free and wall-free.
30. **Brave Rewards.** Verify as a creator, collect tips from Brave users. Tiny.
31. **Opt-in cryptomining.** "Lend us your CPU while you read." Coinhive died of this.
32. **Pay with profile data.** Answer three questions about yourself, get a month free.
33. **Share to unlock.** Pay with reach instead of money.
34. **Tighter meter for blockers.** Three free articles instead of ten. A soft wall.
35. **"Light ads" deal.** "Whitelist us and you get one static ad per page, no tracking."
36. **Join Acceptable Ads.** Pay eyeo, get the light ads shown to the large share of blocker users who keep the default setting.
37. **Cheap Pur-Abo for blockers.** A discounted ad-free subscription offered only to blocker users.

### D. Technical ad recovery

38. **First-party ad serving.** Stitch ads into the HTML server-side, same domain, randomized markup (the SSAI approach from video).
39. **Recovery vendor.** Admiral, Blockthrough and similar reinsert ads for blocker users.
40. **CNAME cloaking.** Run ad tech under your own subdomain. Privacy problem, and uBlock in Firefox uncloaks it.
41. **Obfuscated rendering.** Ads drawn on canvas or shadow DOM to dodge selectors. Hostile.

### E. Other value from the visit

42. **Price sponsorships on total reach.** Count blocker page views when selling in-text sponsorship, since those lines reach everyone.
43. **Reader shop.** Books, merch, archive prints linked where they fit.
44. **Reader events.** In-article invitation to paid events on the topic.
45. **Sponsored utilities.** Dark mode, read later, font size: "presented by X".
46. **Labelled product placement.** In recipes and service pieces, a named brand product with an "Anzeige" note.
47. **Transparency counter.** "You blocked ads worth 0.37 € this month." Guilt as UI.
48. **Supporter badges.** Gamified support, visible in the comments.

## Swiss tournament

**Method.** 48 ideas, 6 rounds (2^6 = 64 > 48, enough to separate a single winner). Round 1 paired at random (fixed seed). Each later round pairs ideas with equal scores, no rematches. Every match is one head-to-head judgement: which idea is better on balance of

- revenue that survives a default blocker setup,
- how little it annoys the reader,
- labelling and editorial integrity,
- effort to build and sell, and how many articles it applies to.

Ties broken by Buchholz (sum of opponents' scores), then by direct encounter.

**Results** (winner > loser):

| Round | Matches |
|---|---|
| 1 | 9>22, 7>35, 11>34, 4>12, 26>15, 2>25, 36>29, 16>45, 24>42, 27>39, 1>6, 20>32, 38>13, 10>41, 8>47, 5>33, 19>46, 30>40, 17>31, 3>37, 44>43, 14>28, 23>48, 18>21 |
| 2 | 36>17, 3>5, 1>8, 16>23, 18>44, 19>27, 11>10, 26>38, 9>30, 4>14, 2>20, 7>24, 25>15, 22>47, 13>35, 6>39, 45>29, 21>12, 31>41, 32>34, 42>28, 46>48, 43>33, 37>40 |
| 3 | 18>11, 3>16, 2>26, 1>19, 4>9, 7>36, 38>5, 8>30, 25>44, 46>32, 17>23, 42>31, 6>14, 45>21, 10>27, 24>13, 37>22, 20>43, 35>41, 39>33, 29>12, 47>40, 15>28, 48>34 |
| 4 | 18>4, 2>1, 7>3, 8>38, 11>42, 10>17, 37>20, 9>45, 16>36, 19>24, 6>46, 26>25, 44>29, 14>23, 30>32, 43>35, 39>48, 27>47, 21>22, 5>15, 13>31, 28>41, 33>40, 12>34 |
| 5 | 2>7, 18>16, 11>26, 1>4, 6>8, 19>9, 3>10, 37>27, 24>44, 13>21, 42>25, 36>43, 5>46, 20>45, 14>39, 17>30, 38>22, 12>48, 29>35, 28>33, 23>31, 15>32, 47>41, 34>40 |
| 6 | 2>18, 7>19, 6>11, 3>1, 37>5, 24>38, 4>17, 36>13, 14>42, 10>20, 8>9, 16>26, 25>46, 39>28, 21>15, 45>44, 43>27, 12>47, 23>30, 29>31, 33>34, 22>32, 35>48, 41>40 |

**Standings (top of the table):**

| Place | Idea | Score | Buchholz |
|---|---|---|---|
| 1 | 2 Classified text ads | 6-0 | 23 |
| 2 | 7 Comparison calculator | 5-1 | 25 (beat #3 in round 4) |
| 3 | 3 Sponsor of the week, editor-written | 5-1 | 25 |
| 4 | 18 Sponsored newsletter teaser | 5-1 | 23 |
| 5 | 6 Affiliate links | 5-1 | 21 |
| 6 | 37 Cheap Pur-Abo for blockers | 5-1 | 15 |
| 7 | 1 Sponsor line | 4-2 | 28 |

Bottom of the table, unsurprisingly: obfuscated rendering, CNAME cloaking, cryptomining, the guilt counter, the tighter meter. Everything that fights the reader lost to almost everything that does not.

## Top 3

### 1. Classified text ads (Kleinanzeigen 2.0)

One labelled line of text at the end of an article, booked self-serve by small businesses, targeted by topic and district, flat weekly price.

- **Why it survives blockers:** plain first-party text in the article flow, no ad request, no ad class names. Default filter lists have nothing to match.
- **Why readers do not mind:** one line, local, often useful, and it looks like the newspaper they grew up with. Nobody writes a filter rule against the bakery.
- **Why it pays:** a long tail of advertisers who never bought programmatic display anyway, so it is new money, not cannibalised money. No sales team needed.
- **Double safety:** text ads like this meet the Acceptable Ads criteria, so even an eyeo whitelist deal covers them for readers who do run strict lists.
- **Risk:** uBlock can hide by text (`:has-text(Anzeige)`). The defence is staying too inoffensive to be worth a rule.

### 2. Comparison calculator in service journalism

An electricity, loan or insurance calculator inside articles about exactly that question, paid per qualified lead.

- **Why it survives blockers:** render it first-party, call the partner API server-side, so no third-party iframe exists to block.
- **Why readers do not mind:** it answers the question the reader came with. It is a tool, not an interruption.
- **Why it pays:** leads in finance and energy pay euros, not cents per thousand views. One converting reader outweighs thousands of blocked banners.
- **Limit:** only fits service content, and it must stay editorially honest (show the cheapest option, not the best-paying partner).

### 3. Sponsor of the week, editor-written

One sponsor per week. The newsroom writes two or three honest sentences about them, labelled, placed at the end of every article and in the feed and newsletter.

- **Why it survives blockers:** same as #1: server-rendered text, first party, part of the page.
- **Why readers do not mind:** one sponsor, a human voice, no tracking. Daring Fireball has run this way for years with readers who are exactly the ad-blocking type.
- **Why it pays:** exclusivity and full reach, including blocker users, sells at a premium (see idea 42: price it on total reach).
- **Limit:** needs a sales relationship per week and a newsroom willing to write the copy without blurring the line to editorial.

### Observation

#1 and #3 are the same mechanism at two price points: self-serve long tail and premium weekly slot. Built together they form one product, "in-text sponsorship", sold on total reach. #4 (sponsored newsletter teaser) is the natural fourth piece, because it adds the one thing the others lack: it moves the blocker reader into a channel where every ad counts.
