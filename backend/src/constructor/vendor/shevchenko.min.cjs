/**
 * @file JavaScript library for declension of Ukrainian anthroponyms
 * @module shevchenko
 * @version 3.2.2
 * @author Oleksandr Tolochko <shevchenko-js@tooleks.com>
 * @license MIT
 * @copyright 2017-2026 Oleksandr Tolochko <shevchenko-js@tooleks.com>
 * @see {@link git+https://github.com/tooleks/shevchenko-js.git}
 */
!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(exports):"function"==typeof define&&define.amd?define(["exports"],t):t((e="undefined"!=typeof globalThis?globalThis:e||self).shevchenko={})}(this,(function(e){"use strict";function t(e,t,n,a){return new(n||(n=Promise))((function(t,i){function s(e){try{o(a.next(e))}catch(e){i(e)}}function r(e){try{o(a.throw(e))}catch(e){i(e)}}function o(e){var a;e.done?t(e.value):(a=e.value,a instanceof n?a:new n((function(e){e(a)}))).then(s,r)}o((a=a.apply(e,[])).next())}))}var n,a;!function(e){e[e["а"]=1]="а",e[e["б"]=2]="б",e[e["в"]=3]="в",e[e["г"]=4]="г",e[e["ґ"]=5]="ґ",e[e["д"]=6]="д",e[e["е"]=7]="е",e[e["є"]=8]="є",e[e["ж"]=9]="ж",e[e["з"]=10]="з",e[e["и"]=11]="и",e[e["і"]=12]="і",e[e["ї"]=13]="ї",e[e["й"]=14]="й",e[e["к"]=15]="к",e[e["л"]=16]="л",e[e["м"]=17]="м",e[e["н"]=18]="н",e[e["о"]=19]="о",e[e["п"]=20]="п",e[e["р"]=21]="р",e[e["с"]=22]="с",e[e["т"]=23]="т",e[e["у"]=24]="у",e[e["ф"]=25]="ф",e[e["х"]=26]="х",e[e["ц"]=27]="ц",e[e["ч"]=28]="ч",e[e["ш"]=29]="ш",e[e["щ"]=30]="щ",e[e["ь"]=31]="ь",e[e["ю"]=32]="ю",e[e["я"]=33]="я"}(n||(n={})),Object.keys(n).length,e.WordClass=void 0,(a=e.WordClass||(e.WordClass={})).NOUN="noun",a.ADJECTIVE="adjective";const i=/[аоуеиіяюєї]/gi;function s(e){return 1===function(e){const t=e.match(i);return null==t?0:t.length}(e)}var r,o,l;function c(e,t=0){const n=e.charAt(t);return n===n.toUpperCase()}function u(e,t=0){const n=e.charAt(t);return n===n.toLowerCase()}e.GrammaticalCase=void 0,(r=e.GrammaticalCase||(e.GrammaticalCase={})).NOMINATIVE="nominative",r.GENITIVE="genitive",r.DATIVE="dative",r.ACCUSATIVE="accusative",r.ABLATIVE="ablative",r.LOCATIVE="locative",r.VOCATIVE="vocative",e.GrammaticalGender=void 0,(o=e.GrammaticalGender||(e.GrammaticalGender={})).MASCULINE="masculine",o.FEMININE="feminine";class h{constructor(e){this.command=e}exec(e){return e+this.command.value}}!function(e){e.REPLACE="replace",e.APPEND="append"}(l||(l={}));class p{constructor(e){this.command=e}exec(){return this.command.value}}class d{make(e){switch(e.action){case l.APPEND:return new h(e);case l.REPLACE:return new p(e);default:throw new TypeError(`Invalid command action: ${e.action}.`)}}}class f{constructor(e){this.rule=e,this.commandRunnerFactory=new d}inflect(e,t){const[n]=this.rule.grammaticalCases[t];if(n){const t=new RegExp(this.rule.pattern.modify,"gi"),a=e.replace(t,((e,...t)=>{let a="";const i=function(e){const t=new RegExp(`${e.toString()}|`).exec("");return null==t?0:t.length-1}(this.rule.pattern.modify);for(let e=0;e<i;e+=1){let i=t[e];const s=n[e];null!=s&&(i=this.commandRunnerFactory.make(s).exec(i)),a+=i}return a}));return function(e,t){let n="";for(let a=0;a<t.length;a+=1){const i=e[a]||e[e.length-1],s=t[a];u(i)?n+=s.toLowerCase():c(i)?n+=s.toUpperCase():n+=s}return n}(e,a)}return e}}class m{constructor(e){this.declensionRules=[...e].sort(((e,t)=>t.priority-e.priority))}inflect(e,n){return t(this,0,void 0,(function*(){const[t]=yield this.findMatchingRules(e,n);return null==t?e:new f(t).inflect(e,n.grammaticalCase)}))}findMatchingRules(e,n){return t(this,0,void 0,(function*(){const t=this.declensionRules.filter((e=>e.gender.includes(n.gender))).filter((e=>!n.applicationType||0===e.applicationType.length||e.applicationType.includes(n.applicationType))).filter((t=>new RegExp(t.pattern.find,"gi").test(e))).filter((e=>!n.wordClass||e.wordClass===n.wordClass)).filter(((e,t,a)=>!n.customRuleFilter||n.customRuleFilter(e,t,a)));return t}))}}const g=new m([{description:"жіноче ім'я любов",examples:["любов"],wordClass:"noun",gender:["feminine"],priority:6,applicationType:["givenName"],pattern:{find:"^любов$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"і"}}],dative:[{0:{action:"append",value:"і"}}],accusative:[],ablative:[{0:{action:"append",value:"'ю"}}],locative:[{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"чоловічі імена федір, сидір",examples:["федір","сидір"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:["givenName"],pattern:{find:"^(федір|сидір)$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"слово суддя",examples:["суддя"],wordClass:"noun",gender:["masculine","feminine"],priority:6,applicationType:["familyName"],pattern:{find:"^суддя$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"е"}}]}},{description:"слово рілля",examples:["рілля"],wordClass:"noun",gender:["masculine","feminine"],priority:6,applicationType:["familyName"],pattern:{find:"^рілля$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"е"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(голосний)вень",examples:["півень"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"[аеєиіїоуюя]вень$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:""},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:""},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:""},2:{action:"replace",value:"еві"}},{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}}],vocative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(голосний)лець",examples:["стрілець","білець"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"[аеєиіїоуюя]лець$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"ь"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"ь"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"ь"},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(к|п|кр|пл|др|жив)іт",examples:["кіт","кріт"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"(к|п|кр|пл|др|жив)іт$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -грім",examples:["грім"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"грім$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(дзвін|хрін)",examples:["дзвін"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"(дзвін|хрін)$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -батіг",examples:["батіг"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"батіг$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"replace",value:"зі"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"replace",value:"гу"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -сокіл",examples:["сокіл"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"сокіл$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -кріль",examples:["кріль"],wordClass:"noun",gender:["masculine"],priority:6,applicationType:[],pattern:{find:"кріль$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"о"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"о"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ю"}}]}},{description:"чоловічі імена ігор, лазар",examples:["ігор","лазар"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"^(ігор|лазар)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"я"}}],dative:[{0:{action:"append",value:"ю"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"я"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"ю"}},{0:{action:"append",value:"еві"}}],vocative:[{0:{action:"append",value:"ю"}}]}},{description:"слово сіль",examples:["сіль"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:["familyName"],pattern:{find:"^сіль$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"і"}}],accusative:[],ablative:[{2:{action:"replace",value:"лю"}}],locative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"е"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(голосний)(твердий приголосний)е(ц|н)ь",examples:["половець"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"[аеєиіїоуюя]([бвгґджзклмнпрстфхцчшщ]|дз|дж)е(ц|н)ь$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:""},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:""},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:""},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:""},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(твердий приголосний)(твердий приголосний)е(ц|н)ь",examples:["жнець"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)([бвгґджзклмнпрстфхцчшщ]|дз|дж)е(ц|н)ь$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(рід|плід)",examples:["рід","плід"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"(рід|плід)$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / чоловічі прізвища на -ніс, без чергування",examples:["іваніс","ханіс","деніс","маніс"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"^([аеєиіїоуюя])?([бвгґджзйклмнпрстфхцчшщ]|дз|дж)[аеєиіїоуюя]ніс$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(з|яв)ір",examples:["дивозір","явір"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"(з|яв|г)ір$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -якір",examples:["якір"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"якір$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"я"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ю"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"еві"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"я"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ем"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"еві"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ю"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -бідь",examples:["лебідь"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:".бідь$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"е"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"е"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -мінь",examples:["кремінь"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:".мінь$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"е"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"е"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"е"},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -сіль",examples:["кисіль"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"сіль$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -кінь",examples:["кінь"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"кінь$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"о"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"і"}},{0:{action:"replace",value:"о"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"о"},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -куліш",examples:["куліш"],wordClass:"noun",gender:["masculine"],priority:5,applicationType:[],pattern:{find:"куліш$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"жіночий рід / на -(твердий приголосний)ька",examples:["ільницька","сумська"],wordClass:"adjective",gender:["feminine"],priority:4,applicationType:["familyName"],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)ька$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"жіночий рід / на -ова",examples:["іванова"],wordClass:"adjective",gender:["feminine"],priority:4,applicationType:["familyName"],pattern:{find:"ова$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"жіночий рід / на -іна",examples:["зеленкіна"],wordClass:"adjective",gender:["feminine"],priority:4,applicationType:["familyName"],pattern:{find:"іна$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(голосний)єць",examples:["заєць"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"[аеєиіїоуюя]єць$",modify:"(.{1})(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"й"},2:{action:"replace",value:"еві"}}],accusative:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"ю"}},{0:{action:"replace",value:"й"},2:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"й"},2:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -віз",examples:["узвіз"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"віз$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ків",examples:["яків"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:["givenName"],pattern:{find:".ків$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(к|р)іп",examples:["прокіп"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:".(к|р)іп$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -піп",examples:["прокіп"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"піп$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ніс",examples:["кривоніс"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"ніс$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -віл",examples:["рябовіл"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"віл$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ріг",examples:["пиріг"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"ріг$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"replace",value:"зі"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -хід",examples:["прихід"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"хід$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"у"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"і"}},{0:{action:"replace",value:"о"},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / жіночий рід / м'яка група / на -(голосний)ль",examples:["мішель","ніколь","cесіль"],wordClass:"noun",gender:["feminine"],priority:4,applicationType:["givenName"],pattern:{find:"[аеєиіїоуюя]ль$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{1:{action:"replace",value:"і"}}],dative:[{1:{action:"replace",value:"і"}}],accusative:[],ablative:[{0:{action:"replace",value:"лл"},1:{action:"replace",value:"ю"}}],locative:[{1:{action:"replace",value:"і"}}],vocative:[]}},{description:"друга відміна / жіночий рід / м'яка група / на (губний_приголосний)",examples:["зейнаб","руф"],wordClass:"noun",gender:["feminine"],priority:4,applicationType:["givenName"],pattern:{find:"[бпвмф]$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"і"}}],dative:[{0:{action:"append",value:"і"}}],accusative:[{0:{action:"append",value:"і"}}],ablative:[{0:{action:"append",value:"і"}}],locative:[{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"і"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ов, -ев (-єв), -ів (-їв), -ін (-їн)",examples:["павлов","нікітін"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:["familyName"],pattern:{find:"([оеє]в|[ії]в|[ії]н)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"им"}}],locative:[{0:{action:"append",value:"і"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ишин",examples:["ковалишин"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"ишин$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"им"}}],locative:[{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(аго|ово)",examples:["живаго"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"(аго|ово)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[],dative:[],accusative:[],ablative:[],locative:[],vocative:[]}},{description:"друга відміна / чоловічий рід / тверда група / на -тер",examples:["вітер","буймистер"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"[іс]тер$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:""},1:{action:"append",value:"у"}}],accusative:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:""},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:""},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -єгер",examples:["єгер"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"єгер$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"я"}}],dative:[{0:{action:"append",value:"ю"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"я"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"ю"}}]}},{description:"перша відміна / чоловічий рід / тверда група / на -світ",examples:["світ"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"світ$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"чоловічі імена / на -(в|д)ір",examples:["дір","вір"],wordClass:"noun",gender:["masculine"],priority:4,applicationType:[],pattern:{find:"(в|д)ір$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"чоловічий рід / на -кій (помилкова транслітерація)",examples:["дідківській"],wordClass:"adjective",gender:["masculine"],priority:3,applicationType:["familyName"],pattern:{find:"кій$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ого"}}],dative:[{0:{action:"replace",value:"ому"}}],accusative:[{0:{action:"replace",value:"ого"}}],ablative:[{0:{action:"replace",value:"им"}}],locative:[{0:{action:"replace",value:"ому"}}],vocative:[]}},{description:"множина / на -их",examples:["седих"],wordClass:"adjective",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"их$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[],dative:[],accusative:[],ablative:[],locative:[],vocative:[]}},{description:"друга відміна / чоловічий рід / тверда група / на -га",examples:["нога"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"га$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{1:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"з"},1:{action:"replace",value:"і"}}],accusative:[{1:{action:"replace",value:"у"}}],ablative:[{1:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"з"},1:{action:"replace",value:"і"}}],vocative:[{1:{action:"replace",value:"о"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -окар, -екар, -етар, -зар, -ухар",examples:["токар","пекар","решетар","кожухар","кобзар"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"(окар|екар|етар|([бвгґджзйклмнпрстфхцчшщ]|дз|дж)зар|ухар)(?<!гузар)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"я"}}],dative:[{0:{action:"append",value:"ю"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"я"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -кіш",examples:["розкіш"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"кіш$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"еві"}}],accusative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"ем"}}],locative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"еві"}}],vocative:[{0:{action:"replace",value:"о"},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -ьо",examples:["іваньо","кузьо"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"ьо$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"append",value:"м"}}],locative:[{0:{action:"replace",value:"ю"}}],vocative:[]}},{description:"друга відміна / чоловічий рід / тверда група / на -ред",examples:["альфред"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"ред$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / бусел, дятел, орел",examples:["бусел","дятел","орел"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"(бус|дят|ор)ел$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}},{0:{action:"replace",value:""},1:{action:"append",value:"у"}}],accusative:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:""},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:""},1:{action:"append",value:"і"}}],vocative:[{0:{action:"replace",value:""},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -е[вмн]",examples:["артем","семен","лев"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"е[вмн]$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ер",examples:["ріхтер"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"ер$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -пес",examples:["пес"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"пес$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:""},1:{action:"append",value:"у"}}],accusative:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:""},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:""},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ко",examples:["марко"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"ко$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"а"}}],dative:[{0:{action:"replace",value:"у"}},{0:{action:"replace",value:"ові"}}],accusative:[{0:{action:"replace",value:"а"}}],ablative:[{0:{action:"replace",value:"ом"}}],locative:[{0:{action:"replace",value:"ові"}},{0:{action:"replace",value:"у"}}],vocative:[{0:{action:"replace",value:"у"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -ий",examples:["батий"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"ий$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"єм"}}],locative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"ї"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"перша відміна / чоловічий рід / тверда група / на -йо",examples:["йойо"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"йо$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"append",value:"ві"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"append",value:"м"}}],locative:[{0:{action:"append",value:"ві"}}],vocative:[]}},{description:"перша відміна / чоловічий рід / тверда група / на -бо",examples:["голембо"],wordClass:"noun",gender:["masculine"],priority:3,applicationType:[],pattern:{find:"бо$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[]}},{description:"чоловічий рід / на -ой, -ий",examples:["толстой","сухомлинський"],wordClass:"adjective",gender:["masculine"],priority:2,applicationType:["familyName"],pattern:{find:"(ой|ий)$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ого"}}],dative:[{0:{action:"replace",value:"ому"}}],accusative:[{0:{action:"replace",value:"ого"}}],ablative:[{0:{action:"replace",value:"им"}}],locative:[{0:{action:"replace",value:"ому"}}],vocative:[]}},{description:"чоловічий рід / на -ій",examples:["заболотній"],wordClass:"adjective",gender:["masculine"],priority:2,applicationType:["familyName"],pattern:{find:"ій$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ього"}}],dative:[{0:{action:"replace",value:"ьому"}}],accusative:[{0:{action:"replace",value:"ього"}}],ablative:[{0:{action:"replace",value:"ім"}}],locative:[{0:{action:"replace",value:"ьому"}}],vocative:[]}},{description:"жіночий рід / на -(твердий приголосний)а",examples:["зелена"],wordClass:"adjective",gender:["feminine"],priority:2,applicationType:["familyName"],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)а$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"жіночий рід / на -(твердий приголосний)я",examples:["задорожня"],wordClass:"adjective",gender:["feminine"],priority:2,applicationType:["familyName"],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)я$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ьої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ьою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"жіночий рід / на -ая",examples:["толстая"],wordClass:"adjective",gender:["feminine"],priority:2,applicationType:["familyName"],pattern:{find:"ая$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"ую"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"жіночий рід / на -яя",examples:["заболотняя"],wordClass:"adjective",gender:["feminine"],priority:2,applicationType:["familyName"],pattern:{find:"яя$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ьої"}}],dative:[{0:{action:"replace",value:"ій"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ьою"}}],locative:[{0:{action:"replace",value:"ій"}}],vocative:[]}},{description:"чоловічі по батькові та прізвища / на -ич",examples:["валерійович","риндич"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:["patronymicName","familyName"],pattern:{find:"ич$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"чоловічі по батькові та прізвища / на -іч",examples:["ілліч"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:["patronymicName","familyName"],pattern:{find:"іч$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"і"}},{0:{action:"append",value:"у"}},{0:{action:"append",value:"еві"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"жіночі по батькові / на -на",examples:["юріївна"],wordClass:"noun",gender:["feminine"],priority:2,applicationType:["patronymicName"],pattern:{find:"на$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"о"}}]}},{description:"жіночі імена / на -(твердий приголосний)я",examples:["неля"],wordClass:"noun",gender:["feminine"],priority:2,applicationType:["givenName"],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)я$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"чоловічі імена / на -ня",examples:["женя"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:["givenName"],pattern:{find:"ня$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -уг",examples:["товстолуг"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:["familyName"],pattern:{find:"уг$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -ин",examples:["гаршин"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:["familyName"],pattern:{find:"(?<!ус|в|н)ин$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"им"}}],locative:[{0:{action:"append",value:"і"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -яр",examples:["скляр"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"яр$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / жіночий рід / тверда, м'яка група / на -(о|ь|твердий приголосний)",examples:["шевченко"],wordClass:"noun",gender:["feminine"],priority:2,applicationType:[],pattern:{find:"(о|ь|([бвгґджзклмнпрстфхцчшщ]|дз|дж))$",modify:"(.{2})$"},grammaticalCases:{nominative:[],genitive:[],dative:[],accusative:[],ablative:[],locative:[],vocative:[]}},{description:"друга відміна / чоловічий рід / тверда група / на -ок",examples:["бурячок"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"((?<=[аеєиіїоуюя].*[аеєиіїоуюя].*л)|(?<=[аеєиіїоуюя].*[^л]))ок$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:""},1:{action:"append",value:"у"}},{0:{action:"replace",value:""},1:{action:"append",value:"ові"}}],accusative:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:""},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}}],vocative:[{0:{action:"replace",value:""},1:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -е(тверда_прилосона)",examples:["марек"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"е([бвгґджзклмнпрстфхцчшщ]|дз|дж)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -(твердий приголосний)я",examples:["гмиря"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)я$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"е"}}]}},{description:"друга відміна / чоловічий, жіночий роди / м'яка група / на -(голосний|ь|й)я",examples:["юлія","майя"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"([аеєиіїоуюя]|ь|й)я$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ї"}}],dative:[{0:{action:"replace",value:"ї"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"єю"}}],locative:[{0:{action:"replace",value:"ї"}}],vocative:[{0:{action:"replace",value:"є"}}]}},{description:"друга відміна / чоловічий рід / мішана група / на -(дж|ж|ч|ш)",examples:["януш","джордж"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"(дж|ж|ч|ш)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"еві"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"і"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -н",examples:["міщанин"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"н$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"і"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / (свекор|цукор)",examples:["свекор","цукор"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"(свекор|цукор)$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],dative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}},{0:{action:"replace",value:""},1:{action:"append",value:"у"}}],accusative:[{0:{action:"replace",value:""},1:{action:"append",value:"а"}}],ablative:[{0:{action:"replace",value:""},1:{action:"append",value:"ом"}}],locative:[{0:{action:"replace",value:""},1:{action:"append",value:"ові"}},{0:{action:"replace",value:""},1:{action:"append",value:"у"}}],vocative:[{0:{action:"replace",value:""},1:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / снігир",examples:["снігир"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"снігир$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"я"}}],dative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"ю"}}],accusative:[{0:{action:"append",value:"я"}}],ablative:[{0:{action:"append",value:"ем"}}],locative:[{0:{action:"append",value:"еві"}},{0:{action:"append",value:"ю"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -к",examples:["кузик","мисяк"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"к$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -х",examples:["кожух"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"х$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}}],vocative:[{0:{action:"append",value:"у"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / соловей",examples:["соловей"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"соловей$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:""},1:{action:"replace",value:"'я"}}],dative:[{0:{action:"replace",value:""},1:{action:"replace",value:"'єві"}},{0:{action:"replace",value:""},1:{action:"replace",value:"'ю"}}],accusative:[{0:{action:"replace",value:""},1:{action:"replace",value:"'я"}}],ablative:[{0:{action:"replace",value:""},1:{action:"replace",value:"'єм"}}],locative:[{0:{action:"replace",value:""},1:{action:"replace",value:"'ї"}},{0:{action:"replace",value:""},1:{action:"replace",value:"'ю"}},{0:{action:"replace",value:""},1:{action:"replace",value:"'єві"}}],vocative:[{0:{action:"replace",value:""},1:{action:"replace",value:"'ю"}}]}},{description:"перша відміна / чоловічий, жіночий роди / тверда група / на -ха",examples:["старуха"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"ха$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{1:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"с"},1:{action:"replace",value:"і"}}],accusative:[{1:{action:"replace",value:"у"}}],ablative:[{1:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"с"},1:{action:"replace",value:"і"}}],vocative:[{1:{action:"replace",value:"о"}},{1:{action:"replace",value:"а"}}]}},{description:"перша відміна / чоловічий, жіночий роди / тверда група / на -ка",examples:["прилука"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"ка$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{1:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"ц"},1:{action:"replace",value:"і"}}],accusative:[{1:{action:"replace",value:"у"}}],ablative:[{1:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"ц"},1:{action:"replace",value:"і"}}],vocative:[{1:{action:"replace",value:"о"}},{1:{action:"replace",value:"а"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / журавель",examples:["журавель"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"журавель$",modify:"(.{3})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ля"}}],dative:[{0:{action:"replace",value:"леві"}},{0:{action:"replace",value:"лю"}}],accusative:[{0:{action:"replace",value:"ля"}}],ablative:[{0:{action:"replace",value:"лем"}}],locative:[{0:{action:"replace",value:"лю"}},{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"лю"}}]}},{description:"перша відміна / чоловічий рід / тверда група / на -(твердий приголосний)о",examples:["петро","павло"],wordClass:"noun",gender:["masculine"],priority:2,applicationType:[],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)о$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"а"}}],dative:[{0:{action:"replace",value:"у"}}],accusative:[{0:{action:"replace",value:"а"}}],ablative:[{0:{action:"replace",value:"ом"}}],locative:[{0:{action:"replace",value:"ові"}}],vocative:[{0:{action:"replace",value:"е"}}]}},{description:"перша відміна / жіночий рід / тверда група / на -(г|ґ)а",examples:["ольга"],wordClass:"noun",gender:["feminine"],priority:2,applicationType:[],pattern:{find:"(г|ґ)а$",modify:"(.{1})(.{1})$"},grammaticalCases:{nominative:[],genitive:[{1:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"з"},1:{action:"replace",value:"і"}}],accusative:[{1:{action:"replace",value:"у"}}],ablative:[{1:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"з"},1:{action:"replace",value:"і"}}],vocative:[{1:{action:"replace",value:"о"}}]}},{description:"перша відміна / чоловічий рід / тверда група / на -ле",examples:["поле"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"ле$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}}],accusative:[{0:{action:"replace",value:"е"}}],ablative:[{0:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[]}},{description:"перша відміна / чоловічий, жіночий роди / мішана група / на -а",examples:["мойша"],wordClass:"noun",gender:["masculine","feminine"],priority:2,applicationType:[],pattern:{find:"(дж|ж|ч|ш|щ)а$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"і"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ею"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"о"}}]}},{description:"друга відміна / чоловічий рід / тверда група / на -(твердий приголосний)",examples:["олександр"],wordClass:"noun",gender:["masculine"],priority:1,applicationType:[],pattern:{find:"([бвгґджзклмнпрстфхцчшщ]|дз|дж)$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"append",value:"а"}}],dative:[{0:{action:"append",value:"у"}},{0:{action:"append",value:"ові"}}],accusative:[{0:{action:"append",value:"а"}}],ablative:[{0:{action:"append",value:"ом"}}],locative:[{0:{action:"append",value:"ові"}},{0:{action:"append",value:"у"}}],vocative:[{0:{action:"append",value:"е"}}]}},{description:"перша відміна / чоловічий, жіночий роди / тверда група / на -а",examples:["анна"],wordClass:"noun",gender:["masculine","feminine"],priority:1,applicationType:[],pattern:{find:"а$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"и"}}],dative:[{0:{action:"replace",value:"і"}}],accusative:[{0:{action:"replace",value:"у"}}],ablative:[{0:{action:"replace",value:"ою"}}],locative:[{0:{action:"replace",value:"і"}}],vocative:[{0:{action:"replace",value:"о"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -й",examples:["валерій"],wordClass:"noun",gender:["masculine"],priority:1,applicationType:[],pattern:{find:"й$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"єві"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"єм"}}],locative:[{0:{action:"replace",value:"єві"}},{0:{action:"replace",value:"ю"}},{0:{action:"replace",value:"ї"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"друга відміна / чоловічий рід / м'яка група / на -ь",examples:["петрунь"],wordClass:"noun",gender:["masculine"],priority:1,applicationType:[],pattern:{find:"ь$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"я"}}],dative:[{0:{action:"replace",value:"ю"}}],accusative:[{0:{action:"replace",value:"я"}}],ablative:[{0:{action:"replace",value:"ем"}}],locative:[{0:{action:"replace",value:"еві"}}],vocative:[{0:{action:"replace",value:"ю"}}]}},{description:"жіночі імена / на -'я",examples:["дар'я","мар'я"],wordClass:"noun",gender:["feminine"],priority:1,applicationType:["givenName"],pattern:{find:"['’ʼ]я$",modify:"(.{1})$"},grammaticalCases:{nominative:[],genitive:[{0:{action:"replace",value:"ї"}}],dative:[{0:{action:"replace",value:"ї"}}],accusative:[{0:{action:"replace",value:"ю"}}],ablative:[{0:{action:"replace",value:"єю"}}],locative:[{0:{action:"replace",value:"ї"}}],vocative:[{0:{action:"replace",value:"є"}}]}}]);class v{constructor(e,t){this.backend=e,this.dataMover=t,this.data=new WeakMap,this.dataIdsCount=0}get(e){return this.data.has(e)||this.dataMover.moveData(this.backend,e),this.data.get(e)}set(e,t){this.dataIdsCount++,this.data.set(e,t)}has(e){return this.data.has(e)}delete(e){return this.dataIdsCount--,this.data.delete(e)}numDataIds(){return this.dataIdsCount}}class y{refCount(e){return b("refCount")}incRef(e){return b("incRef")}timerAvailable(){return!0}time(e){return b("time")}read(e){return b("read")}readSync(e){return b("readSync")}readToGPU(e,t){return b("readToGPU")}numDataIds(){return b("numDataIds")}disposeData(e,t){return b("disposeData")}write(e,t,n){return b("write")}move(e,t,n,a,i){return b("move")}createTensorFromGPUData(e,t,n){return b("createTensorFromGPUData")}memory(){return b("memory")}floatPrecision(){return b("floatPrecision")}epsilon(){return 32===this.floatPrecision()?1e-7:1e-4}dispose(){return b("dispose")}}function b(e){throw new Error(`'${e}' not yet implemented or not found in the registry. This kernel may not be supported by the tfjs backend you have chosen`)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function w(e){let t=e.length,n=0;for(;t>0;)n=Math.random()*t|0,t--,k(e,t,n)}function k(e,t,n){const a=e[t];e[t]=e[n],e[n]=a}function x(e,t){if(!e)throw new Error("string"==typeof t?t:t())}function S(e){x(null!=e,(()=>"The input to the tensor constructor must be a non-null value."))}function N(e){if(0===e.length)return 1;let t=e[0];for(let n=1;n<e.length;n++)t*=e[n];return t}function T(e,t){if(e===t)return!0;if(null==e||null==t)return!1;if(e.length!==t.length)return!1;for(let n=0;n<e.length;n++)if(e[n]!==t[n])return!1;return!0}function I(e){return e%1==0}function C(e,t){return t<=e.length?e:e+" ".repeat(t-e.length)}function $(e,t){const n=t.length;return x((e=null==e?t.map(((e,t)=>t)):[].concat(e)).every((e=>e>=-n&&e<n)),(()=>`All values in axis param must be in range [-${n}, ${n}) but got axis ${e}`)),x(e.every((e=>I(e))),(()=>`All values in axis param must be integers but got axis ${e}`)),e.map((e=>e<0?n+e:e))}function A(e,t){return E(e,t)}function E(e,t){let n=null;if(null==e||"float32"===e)n=new Float32Array(t);else if("int32"===e)n=new Int32Array(t);else if("bool"===e)n=new Uint8Array(t);else{if("string"!==e)throw new Error(`Unknown data type ${e}`);n=new Array(t)}return n}function j(e){if("float32"===e||"int32"===e)return 4;if("complex64"===e)return 8;if("bool"===e)return 1;throw new Error(`Unknown dtype ${e}`)}function z(e){return"string"==typeof e||e instanceof String}function D(e){return"number"==typeof e}function F(e){return Array.isArray(e)?F(e[0]):e instanceof Float32Array?"float32":e instanceof Int32Array||e instanceof Uint8Array||e instanceof Uint8ClampedArray?"int32":D(e)?"float32":z(e)?"string":"boolean"==typeof e?"bool":"float32"}function _(e){return!!(e&&e.constructor&&e.call&&e.apply)}function R(e){const t=e.length;if(t<2)return[];const n=new Array(t-1);n[t-2]=e[t-1];for(let a=t-3;a>=0;--a)n[a]=n[a+1]*e[a+1];return n}function L(e,t,n,a=!1){const i=new Array;if(1===t.length){const s=t[0]*(a?2:1);for(let t=0;t<s;t++)i[t]=n[e+t]}else{const s=t[0],r=t.slice(1),o=r.reduce(((e,t)=>e*t))*(a?2:1);for(let t=0;t<s;t++)i[t]=L(e+t*o,r,n,a)}return i}function M(e,t,n=!1){if(0===e.length)return t[0];const a=e.reduce(((e,t)=>e*t))*(n?2:1);if(0===a)return[];if(a!==t.length)throw new Error(`[${e}] does not match the input size ${t.length}${n?" for a complex tensor":""}.`);return L(0,e,t,n)}function O(e,t){const n=P(e,t);for(let e=0;e<n.length;e++)n[e]=1;return n}function P(e,t){if(null==t||"float32"===t||"complex64"===t)return new Float32Array(e);if("int32"===t)return new Int32Array(e);if("bool"===t)return new Uint8Array(e);throw new Error(`Unknown data type ${t}`)}function B(e){e.forEach((t=>{x(Number.isInteger(t)&&t>=0,(()=>`Tensor must have a shape comprised of positive integers but got shape [${e}].`))}))}function U(e,t,n){if(0===t)return 0;if(1===t)return e[0];let a=e[e.length-1];for(let t=0;t<e.length-1;++t)a+=n[t]*e[t];return a}function W(e,t,n){if(0===t)return[];if(1===t)return[e];const a=new Array(t);for(let t=0;t<a.length-1;++t)a[t]=Math.floor(e/n[t]),e-=a[t]*n[t];return a[a.length-1]=e,a}function G(e){return e&&e.then&&"function"==typeof e.then}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const V="tfjsflags";class K{constructor(e){this.global=e,this.flags={},this.flagRegistry={},this.urlFlags={},this.getQueryParams=q,this.populateURLFlags()}setPlatform(e,t){null!=this.platform&&(H().getBool("IS_TEST")||H().getBool("PROD")||console.warn(`Platform ${this.platformName} has already been set. Overwriting the platform with ${e}.`)),this.platformName=e,this.platform=t}registerFlag(e,t,n){if(this.flagRegistry[e]={evaluationFn:t,setHook:n},null!=this.urlFlags[e]){const t=this.urlFlags[e];H().getBool("IS_TEST")||H().getBool("PROD")||console.warn(`Setting feature override from URL ${e}: ${t}.`),this.set(e,t)}}async getAsync(e){return e in this.flags||(this.flags[e]=await this.evaluateFlag(e)),this.flags[e]}get(e){if(e in this.flags)return this.flags[e];const t=this.evaluateFlag(e);if(G(t))throw new Error(`Flag ${e} cannot be synchronously evaluated. Please use getAsync() instead.`);return this.flags[e]=t,this.flags[e]}getNumber(e){return this.get(e)}getBool(e){return this.get(e)}getString(e){return this.get(e)}getFlags(){return this.flags}get features(){return this.flags}set(e,t){if(null==this.flagRegistry[e])throw new Error(`Cannot set flag ${e} as it has not been registered.`);this.flags[e]=t,null!=this.flagRegistry[e].setHook&&this.flagRegistry[e].setHook(t)}evaluateFlag(e){if(null==this.flagRegistry[e])throw new Error(`Cannot evaluate flag '${e}': no evaluation function found.`);return this.flagRegistry[e].evaluationFn()}setFlags(e){this.flags=Object.assign({},e)}reset(){this.flags={},this.urlFlags={},this.populateURLFlags()}populateURLFlags(){if(void 0===this.global||void 0===this.global.location||void 0===this.global.location.search)return;const e=this.getQueryParams(this.global.location.search);if(V in e){e[V].split(",").forEach((e=>{const[t,n]=e.split(":");this.urlFlags[t]=function(e,t){const n=t.toLowerCase();return"true"===n||"false"===n?"true"===n:""+ +n===n?+n:t}(0,n)}))}}}function q(e){const t={};return e.replace(/[?&]([^=?&]+)(?:=([^&]*))?/g,((e,...n)=>(function(e,t,n){e[decodeURIComponent(t)]=decodeURIComponent(n||"")}(t,n[0],n[1]),n.join("=")))),t}function H(){return Z}let J,Z=null;function Y(){if(null==J){let e;if("undefined"!=typeof window)e=window;else if("undefined"!=typeof global)e=global;else if("undefined"!=typeof process)e=process;else{if("undefined"==typeof self)throw new Error("Could not find a global object");e=self}J=e}return J}function Q(e,t){const n=function(){const e=Y();return null==e._tfGlobals&&(e._tfGlobals=new Map),e._tfGlobals}();if(n.has(e))return n.get(e);{const a=t();return n.set(e,a),n.get(e)}}const X="Add",ee="ArgMax",te="AvgPool",ne="AvgPool3D",ae="BatchMatMul",ie="BatchToSpaceND",se="Cast",re="ClipByValue",oe="ComplexAbs",le="Concat",ce="Conv2D",ue="Conv2DBackpropInput",he="Conv3D",pe="Cosh",de="Cumsum",fe="DepthwiseConv2dNative",me="RealDiv",ge="Elu",ve="ExpandDims",ye="Floor",be="FloorDiv",we="FusedBatchNorm",ke="GatherV2",xe="GreaterEqual",Se="Identity",Ne="LeakyRelu",Te="Log1p",Ie="Maximum",Ce="MaxPool",$e="MaxPool3D",Ae="Mean",Ee="Minimum",je="Multiply",ze="OnesLike",De="OneHot",Fe="Pack",_e="PadV2",Re="Prelu",Le="Relu",Me="Reshape",Oe="ResizeNearestNeighbor",Pe="ResizeBilinear",Be="Relu6",Ue="Reverse",We="Round",Ge="Rsqrt",Ve="Select",Ke="Selu",qe="Slice",He="Sinh",Je="Sigmoid",Ze="Softplus",Ye="Sqrt",Qe="Sum",Xe="SpaceToBatchND",et="SplitV",tt="Softmax",nt="Tanh",at="Tile",it="Transpose",st="Unpack",rt="UnsortedSegmentSum",ot="ZerosLike",lt="Step",ct="_FusedMatMul",ut="FusedConv2D";
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function ht(...e){H().getBool("IS_TEST")||H().getBool("PROD")||console.warn(...e)}
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const pt=Q("kernelRegistry",(()=>new Map)),dt=Q("gradRegistry",(()=>new Map));function ft(e,t){const n=bt(e,t);return pt.get(n)}function mt(e){return dt.get(e)}function gt(e){const t=pt.entries(),n=[];for(;;){const{done:a,value:i}=t.next();if(a)break;const[s,r]=i,[o]=s.split("_");o===e&&n.push(r)}return n}function vt(e){const{kernelName:t,backendName:n}=e,a=bt(t,n);pt.has(a)&&ht(`The kernel '${t}' for backend '${n}' is already registered`),pt.set(a,e)}function yt(e){const{kernelName:t}=e;dt.has(t)&&H().getBool("DEBUG")&&ht(`Overriding the gradient for '${t}'`),dt.set(t,e)}function bt(e,t){return`${t}_${e}`}
/**
     * @license
     * Copyright 2023 Google LLC.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function wt(e){return e instanceof Float32Array||e instanceof Int32Array||e instanceof Uint8Array||e instanceof Uint8ClampedArray}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function kt(e,t){if("string"===t)throw new Error("Cannot convert a string[] to a TypedArray");if(Array.isArray(e)&&(e=It(e)),H().getBool("DEBUG")&&function(e,t){for(let n=0;n<e.length;n++){const a=e[n];if(isNaN(a)||!isFinite(a))throw Error(`A tensor of type ${t} being uploaded contains ${a}.`)}}(e,t),function(e,t){return e instanceof Float32Array&&"float32"===t||e instanceof Int32Array&&"int32"===t||e instanceof Uint8Array&&"bool"===t}(e,t))return e;if(null==t||"float32"===t||"complex64"===t)return new Float32Array(e);if("int32"===t)return new Int32Array(e);if("bool"===t){const t=new Uint8Array(e.length);for(let n=0;n<t.length;++n)0!==Math.round(e[n])&&(t[n]=1);return t}throw new Error(`Unknown data type ${t}`)}function xt(){return H().platform.now()}function St(e,t="utf-8"){return t=t||"utf-8",H().platform.encode(e,t)}function Nt(e,t="utf-8"){return t=t||"utf-8",H().platform.decode(e,t)}function Tt(e){return null!=H().platform.isTypedArray?H().platform.isTypedArray(e):wt(e)}function It(e,t=[],n=!1){if(null==t&&(t=[]),"boolean"==typeof e||"number"==typeof e||"string"==typeof e||G(e)||null==e||Tt(e)&&n)t.push(e);else if(Array.isArray(e)||Tt(e))for(let a=0;a<e.length;++a)It(e[a],t,n);else{let a=-1;for(const t of Object.keys(e))/^([1-9]+[0-9]*|0)$/.test(t)&&(a=Math.max(a,Number(t)));for(let i=0;i<=a;i++)It(e[i],t,n)}return t}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class Ct{constructor(e,t){this.backendTimer=e,this.logger=t,null==t&&(this.logger=new At)}profileKernel(e,t,n){let a;const i=()=>{a=n()};let s;const r=xt();if(this.backendTimer.timerAvailable())s=this.backendTimer.time(i);else{i();for(const e of a)e.dataSync();s=Promise.resolve({kernelMs:xt()-r})}if(H().getBool("CHECK_COMPUTATION_FOR_ERRORS"))for(let t=0;t<a.length;t++){const n=a[t];n.data().then((t=>{$t(t,n.dtype,e)}))}return{kernelName:e,outputs:a,inputs:t,timeMs:s.then((e=>e.kernelMs)),extraInfo:s.then((e=>null!=e.getExtraProfileInfo?e.getExtraProfileInfo():""))}}logKernelProfile(e){const{kernelName:t,outputs:n,timeMs:a,inputs:i,extraInfo:s}=e;n.forEach((e=>{Promise.all([e.data(),a,s]).then((n=>{this.logger.logKernelProfile(t,e,n[0],n[1],i,n[2])}))}))}}function $t(e,t,n){if("float32"!==t)return!1;for(let t=0;t<e.length;t++){const a=e[t];if(isNaN(a)||!isFinite(a))return console.warn(`Found ${a} in the result of '${n}'`),!0}return!1}class At{logKernelProfile(e,t,n,a,i,s){const r="number"==typeof a?C(`${a}ms`,9):a.error,o=C(e,25),l=t.rank,c=t.size,u=C(t.shape.toString(),14);let h="";for(const e in i){const n=i[e];if(null!=n){const a=n.shape||t.shape,i=a.length;h+=`${e}: ${i}D ${i>0?a:""} `}}console.log(`%c${o}\t%c${r}\t%c${l}D ${u}\t%c${c}\t%c${h}\t%c${s}`,"font-weight:bold","color:red","color:blue","color: orange","color: green","color: steelblue")}}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Et(e,t,n,a){const i=R(t),s=function(e,t,n,a){const i=N(t),s=a[a.length-1],r=new Array(s).fill(0),o=t.length,l="complex64"===n?Ft(e):e;if(o>1)for(let e=0;e<i/s;e++){const t=e*s;for(let e=0;e<s;e++)r[e]=Math.max(r[e],jt(l[t+e],0,n).length)}return r}(e,t,n,i),r=t.length,o=Dt(e,t,n,i,s),l=["Tensor"];return a&&(l.push(`  dtype: ${n}`),l.push(`  rank: ${r}`),l.push(`  shape: [${t}]`),l.push("  values:")),l.push(o.map((e=>"    "+e)).join("\n")),l.join("\n")}function jt(e,t,n){let a;return a=Array.isArray(e)?`${parseFloat(e[0].toFixed(7))} + ${parseFloat(e[1].toFixed(7))}j`:z(e)?`'${e}'`:"bool"===n?zt(e):parseFloat(e.toFixed(7)).toString(),C(a,t)}function zt(e){return 0===e?"false":"true"}function Dt(e,t,n,a,i,s=!0){const r="complex64"===n?2:1,o=t[0],l=t.length;if(0===l){if("complex64"===n){return[jt(Ft(e)[0],0,n)]}return"bool"===n?[zt(e[0])]:[e[0].toString()]}if(1===l){if(o>20){const t=3*r;let a=Array.from(e.slice(0,t)),s=Array.from(e.slice((o-3)*r,o*r));return"complex64"===n&&(a=Ft(a),s=Ft(s)),["["+a.map(((e,t)=>jt(e,i[t],n))).join(", ")+", ..., "+s.map(((e,t)=>jt(e,i[o-3+t],n))).join(", ")+"]"]}return["["+("complex64"===n?Ft(e):Array.from(e)).map(((e,t)=>jt(e,i[t],n))).join(", ")+"]"]}const c=t.slice(1),u=a.slice(1),h=a[0]*r,p=[];if(o>20){for(let t=0;t<3;t++){const a=t*h,s=a+h;p.push(...Dt(e.slice(a,s),c,n,u,i,!1))}p.push("...");for(let t=o-3;t<o;t++){const a=t*h,s=a+h;p.push(...Dt(e.slice(a,s),c,n,u,i,t===o-1))}}else for(let t=0;t<o;t++){const a=t*h,s=a+h;p.push(...Dt(e.slice(a,s),c,n,u,i,t===o-1))}const d=2===l?",":"";p[0]="["+(o>0?p[0]+d:"");for(let e=1;e<p.length-1;e++)p[e]=" "+p[e]+d;let f=",\n";for(let e=2;e<l;e++)f+="\n";return p[p.length-1]=" "+p[p.length-1]+"]"+(s?"":f),p}function Ft(e){const t=[];for(let n=0;n<e.length;n+=2)t.push([e[n],e[n+1]]);return t}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class _t{constructor(e,t,n){if(this.dtype=t,this.shape=e.slice(),this.size=N(e),null!=n){const e=n.length;x(e===this.size,(()=>`Length of values '${e}' does not match the size inferred by the shape '${this.size}'.`))}if("complex64"===t)throw new Error("complex64 dtype TensorBuffers are not supported. Please create a TensorBuffer for the real and imaginary parts separately and call tf.complex(real, imag).");this.values=n||E(t,this.size),this.strides=R(e)}set(e,...t){0===t.length&&(t=[0]),x(t.length===this.rank,(()=>`The number of provided coordinates (${t.length}) must match the rank (${this.rank})`));const n=this.locToIndex(t);this.values[n]=e}get(...e){0===e.length&&(e=[0]);let t=0;for(const n of e){if(n<0||n>=this.shape[t]){const t=`Requested out of range element at ${e}.   Buffer shape=${this.shape}`;throw new Error(t)}t++}let n=e[e.length-1];for(let t=0;t<e.length-1;++t)n+=this.strides[t]*e[t];return this.values[n]}locToIndex(e){if(0===this.rank)return 0;if(1===this.rank)return e[0];let t=e[e.length-1];for(let n=0;n<e.length-1;++n)t+=this.strides[n]*e[n];return t}indexToLoc(e){if(0===this.rank)return[];if(1===this.rank)return[e];const t=new Array(this.shape.length);for(let n=0;n<t.length-1;++n)t[n]=Math.floor(e/this.strides[n]),e-=t[n]*this.strides[n];return t[t.length-1]=e,t}get rank(){return this.shape.length}toTensor(){return Rt().makeTensor(this.values,this.shape,this.dtype)}}let Rt=null,Lt=null;class Mt{constructor(e,t,n,a){this.kept=!1,this.isDisposedInternal=!1,this.shape=e.slice(),this.dtype=t||"float32",this.size=N(e),this.strides=R(e),this.dataId=n,this.id=a,this.rankType=this.rank<5?this.rank.toString():"higher"}get rank(){return this.shape.length}async buffer(){const e=await this.data();return Lt.buffer(this.shape,this.dtype,e)}bufferSync(){return Lt.buffer(this.shape,this.dtype,this.dataSync())}async array(){const e=await this.data();return M(this.shape,e,"complex64"===this.dtype)}arraySync(){return M(this.shape,this.dataSync(),"complex64"===this.dtype)}async data(){this.throwIfDisposed();const e=Rt().read(this.dataId);if("string"===this.dtype){const t=await e;try{return t.map((e=>Nt(e)))}catch(e){throw new Error("Failed to decode the string bytes into utf-8. To get the original bytes, call tensor.bytes().")}}return e}dataToGPU(e){return this.throwIfDisposed(),Rt().readToGPU(this.dataId,e)}dataSync(){this.throwIfDisposed();const e=Rt().readSync(this.dataId);if("string"===this.dtype)try{return e.map((e=>Nt(e)))}catch(e){throw new Error("Failed to decode the string bytes into utf-8. To get the original bytes, call tensor.bytes().")}return e}async bytes(){this.throwIfDisposed();const e=await Rt().read(this.dataId);return"string"===this.dtype?e:new Uint8Array(e.buffer)}dispose(){this.isDisposed||(this.kerasMask&&this.kerasMask.dispose(),Rt().disposeTensor(this),this.isDisposedInternal=!0)}get isDisposed(){return this.isDisposedInternal}throwIfDisposed(){if(this.isDisposed)throw new Error("Tensor is disposed.")}print(e=!1){return Lt.print(this,e)}clone(){return this.throwIfDisposed(),Lt.clone(this)}toString(e=!1){return Et(this.dataSync(),this.shape,this.dtype,e)}cast(e){return this.throwIfDisposed(),Lt.cast(this,e)}variable(e=!0,t,n){return this.throwIfDisposed(),Rt().makeVariable(this,e,t,n)}}function Ot(){return Q("Tensor",(()=>Mt))}Object.defineProperty(Mt,Symbol.hasInstance,{value:e=>!!e&&null!=e.data&&null!=e.dataSync&&null!=e.throwIfDisposed}),Ot();class Pt extends Mt{constructor(e,t,n,a){super(e.shape,e.dtype,e.dataId,a),this.trainable=t,this.name=n}assign(e){if(e.dtype!==this.dtype)throw new Error(`dtype of the new value (${e.dtype}) and previous value (${this.dtype}) must match`);if(!T(e.shape,this.shape))throw new Error(`shape of the new value (${e.shape}) and previous value (${this.shape}) must match`);Rt().disposeTensor(this),this.dataId=e.dataId,Rt().incRef(this,null)}dispose(){Rt().disposeVariable(this),this.isDisposedInternal=!0}}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
var Bt,Ut,Wt,Gt,Vt;Object.defineProperty(Pt,Symbol.hasInstance,{value:e=>e instanceof Mt&&null!=e.assign&&e.assign instanceof Function}),function(e){e.R0="R0",e.R1="R1",e.R2="R2",e.R3="R3",e.R4="R4",e.R5="R5",e.R6="R6"}(Bt||(Bt={})),function(e){e.float32="float32",e.int32="int32",e.bool="int32",e.complex64="complex64"}(Ut||(Ut={})),function(e){e.float32="float32",e.int32="int32",e.bool="bool",e.complex64="complex64"}(Wt||(Wt={})),function(e){e.float32="float32",e.int32="float32",e.bool="float32",e.complex64="complex64"}(Gt||(Gt={})),function(e){e.float32="complex64",e.int32="complex64",e.bool="complex64",e.complex64="complex64"}(Vt||(Vt={}));const Kt={float32:Gt,int32:Ut,bool:Wt,complex64:Vt};function qt(e,t){if("string"===e||"string"===t){if("string"===e&&"string"===t)return"string";throw new Error(`Can not upcast ${e} with ${t}`)}return Kt[e][t]}function Ht(e){return null!=e&&"object"==typeof e&&"texture"in e&&e.texture instanceof WebGLTexture}function Jt(e){return"undefined"!=typeof GPUBuffer&&null!=e&&"object"==typeof e&&"buffer"in e&&e.buffer instanceof GPUBuffer}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Zt(e,t){if(e.dtype===t.dtype)return[e,t];const n=qt(e.dtype,t.dtype);return[e.cast(n),t.cast(n)]}function Yt(e){const t=[];return Qt(e,t,new Set),t}function Qt(e,t,n){if(null==e)return;if(e instanceof Mt)return void t.push(e);if(a=e,!Array.isArray(a)&&"object"!=typeof a)return;var a;
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const i=e;for(const e in i){const a=i[e];n.has(a)||(n.add(a),Qt(a,t,n))}}function Xt(e){return null!=e.kernelName}class en{constructor(){this.registeredVariables={},this.nextTapeNodeId=0,this.numBytes=0,this.numTensors=0,this.numStringTensors=0,this.numDataBuffers=0,this.gradientDepth=0,this.kernelDepth=0,this.scopeStack=[],this.numDataMovesStack=[],this.nextScopeId=0,this.tensorInfo=new WeakMap,this.profiling=!1,this.activeProfile={newBytes:0,newTensors:0,peakBytes:0,kernels:[],result:null,get kernelNames(){return Array.from(new Set(this.kernels.map((e=>e.name))))}}}dispose(){for(const e in this.registeredVariables)this.registeredVariables[e].dispose()}}class tn{constructor(e){this.ENV=e,this.registry={},this.registryFactory={},this.pendingBackendInitId=0,this.state=new en}async ready(){if(null!=this.pendingBackendInit)return this.pendingBackendInit.then((()=>{}));if(null!=this.backendInstance)return;const e=this.getSortedBackends();for(let t=0;t<e.length;t++){const n=e[t];if(await this.initializeBackend(n).success)return void await this.setBackend(n)}throw new Error("Could not initialize any backends, all backend initializations failed.")}get backend(){if(null!=this.pendingBackendInit)throw new Error(`Backend '${this.backendName}' has not yet been initialized. Make sure to await tf.ready() or await tf.setBackend() before calling other methods`);if(null==this.backendInstance){const{name:e,asyncInit:t}=this.initializeBackendsAndReturnBest();if(t)throw new Error(`The highest priority backend '${e}' has not yet been initialized. Make sure to await tf.ready() or await tf.setBackend() before calling other methods`);this.setBackend(e)}return this.backendInstance}backendNames(){return Object.keys(this.registryFactory)}findBackend(e){if(!(e in this.registry)){if(!(e in this.registryFactory))return null;{const{asyncInit:t}=this.initializeBackend(e);if(t)return null}}return this.registry[e]}findBackendFactory(e){return e in this.registryFactory?this.registryFactory[e].factory:null}registerBackend(e,t,n=1){return e in this.registryFactory?(ht(`${e} backend was already registered. Reusing existing backend factory.`),!1):(this.registryFactory[e]={factory:t,priority:n},!0)}async setBackend(e){if(null==this.registryFactory[e])throw new Error(`Backend name '${e}' not found in registry`);if(this.backendName=e,null==this.registry[e]){this.backendInstance=null;const{success:t,asyncInit:n}=this.initializeBackend(e);if(!(n?await t:t))return!1}return this.backendInstance=this.registry[e],this.setupRegisteredKernels(),this.profiler=new Ct(this.backendInstance),!0}setupRegisteredKernels(){gt(this.backendName).forEach((e=>{null!=e.setupFunc&&e.setupFunc(this.backendInstance)}))}disposeRegisteredKernels(e){gt(e).forEach((t=>{null!=t.disposeFunc&&t.disposeFunc(this.registry[e])}))}initializeBackend(e){const t=this.registryFactory[e];if(null==t)throw new Error(`Cannot initialize backend ${e}, no registration found.`);try{const n=t.factory();if(!n||n instanceof y||"function"!=typeof n.then)return this.registry[e]=n,{success:!0,asyncInit:!1};{const t=++this.pendingBackendInitId,a=n.then((n=>!(t<this.pendingBackendInitId)&&(this.registry[e]=n,this.pendingBackendInit=null,!0))).catch((n=>(t<this.pendingBackendInitId||(this.pendingBackendInit=null,ht(`Initialization of backend ${e} failed`),ht(n.stack||n.message)),!1)));return this.pendingBackendInit=a,{success:a,asyncInit:!0}}}catch(t){return ht(`Initialization of backend ${e} failed`),ht(t.stack||t.message),{success:!1,asyncInit:!1}}}removeBackend(e){if(!(e in this.registryFactory))throw new Error(`${e} backend not found in registry`);this.backendName===e&&null!=this.pendingBackendInit&&this.pendingBackendInitId++,e in this.registry&&(this.disposeRegisteredKernels(e),this.registry[e].dispose(),delete this.registry[e]),delete this.registryFactory[e],this.backendName===e&&(this.pendingBackendInit=null,this.backendName=null,this.backendInstance=null)}getSortedBackends(){if(0===Object.keys(this.registryFactory).length)throw new Error("No backend found in registry.");return Object.keys(this.registryFactory).sort(((e,t)=>this.registryFactory[t].priority-this.registryFactory[e].priority))}initializeBackendsAndReturnBest(){const e=this.getSortedBackends();for(let t=0;t<e.length;t++){const n=e[t],{success:a,asyncInit:i}=this.initializeBackend(n);if(i||a)return{name:n,asyncInit:i}}throw new Error("Could not initialize any backends, all backend initializations failed.")}moveData(e,t){const n=this.state.tensorInfo.get(t),a=n.backend,i=this.readSync(t),s=a.refCount(t);a.disposeData(t,!0),n.backend=e,e.move(t,i,n.shape,n.dtype,s),this.shouldCheckForMemLeaks()&&this.state.numDataMovesStack[this.state.numDataMovesStack.length-1]++}tidy(e,t){let n,a=null;if(null==t){if("function"!=typeof e)throw new Error("Please provide a function to tidy()");t=e}else{if("string"!=typeof e&&!(e instanceof String))throw new Error("When calling with two arguments, the first argument to tidy() must be a string");if("function"!=typeof t)throw new Error("When calling with two arguments, the 2nd argument to tidy() must be a function");a=e}return this.scopedRun((()=>this.startScope(a)),(()=>this.endScope(n)),(()=>(n=t(),n instanceof Promise&&console.error("Cannot return a Promise inside of tidy."),n)))}scopedRun(e,t,n){e();try{const e=n();return t(),e}catch(e){throw t(),e}}nextTensorId(){return tn.nextTensorId++}nextVariableId(){return tn.nextVariableId++}clone(e){const t=an.runKernel(Se,{x:e}),n={x:e};return this.addTapeNode(this.state.activeScope.name,n,[t],(e=>({x:()=>{const t={x:e},n={dtype:"float32"};return an.runKernel(se,t,n)}})),[],{}),t}runKernel(e,t,n){null==this.backendName&&this.backend;if(!(null!=ft(e,this.backendName)))throw new Error(`Kernel '${e}' not registered for backend '${this.backendName}'`);return this.runKernelFunc({kernelName:e,inputs:t,attrs:n})}shouldCheckForMemLeaks(){return this.ENV.getBool("IS_TEST")}checkKernelForMemLeak(e,t,n){const a=this.backend.numDataIds();let i=0;n.forEach((e=>{i+="complex64"===e.dtype?3:1}));const s=this.state.numDataMovesStack[this.state.numDataMovesStack.length-1],r=a-t-i-s;if(r>0)throw new Error(`Backend '${this.backendName}' has an internal memory leak (${r} data ids) after running '${e}'`)}runKernelFunc(e){let t,n=[];const a=this.isTapeOn(),i=this.state.numBytes,s=this.state.numTensors;let r,o;this.shouldCheckForMemLeaks()&&this.state.numDataMovesStack.push(0),null==this.backendName&&this.backend;const l=Xt(e)?e.kernelName:null!=this.state.activeScope?this.state.activeScope.name:"";if(Xt(e)){const{kernelName:t,inputs:i,attrs:s}=e;null==this.backendName&&this.backend;const l=ft(t,this.backendName);x(null!=l,(()=>`Cannot find registered kernel '${t}' for backend '${this.backendName}'`)),r=()=>{const e=this.backend.numDataIds();o=l.kernelFunc({inputs:i,attrs:s,backend:this.backend});const r=Array.isArray(o)?o:[o];this.shouldCheckForMemLeaks()&&this.checkKernelForMemLeak(t,e,r);const c=r.map((e=>null!=e.rank?e:this.makeTensorFromTensorInfo(e)));if(a){const e=this.getTensorsForGradient(t,i,c);n=this.saveTensorsForBackwardMode(e)}return c}}else{const{forwardFunc:t}=e,i=e=>{a&&(n=e.map((e=>this.keep(this.clone(e)))))};r=()=>{const e=this.backend.numDataIds();o=this.tidy((()=>t(this.backend,i)));const n=Array.isArray(o)?o:[o];return this.shouldCheckForMemLeaks()&&this.checkKernelForMemLeak(l,e,n),n}}const{inputs:c,attrs:u}=e,h=Xt(e)?null:e.backwardsFunc;let p;return this.scopedRun((()=>this.state.kernelDepth++),(()=>this.state.kernelDepth--),(()=>{this.ENV.getBool("DEBUG")||this.state.profiling?(p=this.profiler.profileKernel(l,c,(()=>r())),this.ENV.getBool("DEBUG")&&this.profiler.logKernelProfile(p),t=p.outputs):t=r()})),a&&this.addTapeNode(l,c,t,h,n,u),this.state.profiling&&this.state.activeProfile.kernels.push({name:l,bytesAdded:this.state.numBytes-i,totalBytesSnapshot:this.state.numBytes,tensorsAdded:this.state.numTensors-s,totalTensorsSnapshot:this.state.numTensors,inputShapes:Object.keys(c).map((e=>null!=c[e]?c[e].shape:null)),outputShapes:t.map((e=>e.shape)),kernelTimeMs:p.timeMs,extraInfo:p.extraInfo}),Array.isArray(o)?t:t[0]}saveTensorsForBackwardMode(e){const t=e.map((e=>this.keep(this.clone(e))));return t}getTensorsForGradient(e,t,n){const a=mt(e);if(null!=a){const e=a.inputsToSave||[],i=a.outputsToSave||[];let s;a.saveAllInputs?(x(Array.isArray(t),(()=>"saveAllInputs is true, expected inputs to be an array.")),s=Object.keys(t).map((e=>t[e]))):s=e.map((e=>t[e]));const r=n.filter(((e,t)=>i[t]));return s.concat(r)}return[]}makeTensor(e,t,n,a){if(null==e)throw new Error("Values passed to engine.makeTensor() are null");n=n||"float32",a=a||this.backend;let i=e;"string"===n&&z(e[0])&&(i=e.map((e=>St(e))));const s=a.write(i,t,n),r=new Mt(t,n,s,this.nextTensorId());if(this.trackTensor(r,a),"string"===n){const e=this.state.tensorInfo.get(s),t=function(e){if(null==e)return 0;let t=0;return e.forEach((e=>t+=e.length)),t}(i);this.state.numBytes+=t-e.bytes,e.bytes=t}return r}makeTensorFromDataId(e,t,n,a){const i={dataId:e,shape:t,dtype:n=n||"float32"};return this.makeTensorFromTensorInfo(i,a)}makeTensorFromTensorInfo(e,t){const{dataId:n,shape:a,dtype:i}=e,s=new Mt(a,i,n,this.nextTensorId());return this.trackTensor(s,t),s}makeVariable(e,t=!0,n,a){n=n||this.nextVariableId().toString(),null!=a&&a!==e.dtype&&(e=e.cast(a));const i=new Pt(e,t,n,this.nextTensorId());if(null!=this.state.registeredVariables[i.name])throw new Error(`Variable with name ${i.name} was already registered`);return this.state.registeredVariables[i.name]=i,this.incRef(i,this.backend),i}trackTensor(e,t){this.state.numTensors++,"string"===e.dtype&&this.state.numStringTensors++;let n=0;"complex64"!==e.dtype&&"string"!==e.dtype&&(n=e.size*j(e.dtype)),this.state.numBytes+=n,this.state.tensorInfo.has(e.dataId)||(this.state.numDataBuffers++,this.state.tensorInfo.set(e.dataId,{backend:t||this.backend,dtype:e.dtype,shape:e.shape,bytes:n})),e instanceof Pt||this.track(e)}incRef(e,t){this.trackTensor(e,t),this.backend.incRef(e.dataId)}removeDataId(e,t){this.state.tensorInfo.has(e)&&this.state.tensorInfo.get(e).backend===t&&(this.state.tensorInfo.delete(e),this.state.numDataBuffers--)}disposeTensor(e){if(!this.state.tensorInfo.has(e.dataId))return;const t=this.state.tensorInfo.get(e.dataId);if(this.state.numTensors--,"string"===e.dtype&&(this.state.numStringTensors--,this.state.numBytes-=t.bytes),"complex64"!==e.dtype&&"string"!==e.dtype){const t=e.size*j(e.dtype);this.state.numBytes-=t}t.backend.disposeData(e.dataId)&&this.removeDataId(e.dataId,t.backend)}disposeVariables(){for(const e in this.state.registeredVariables){const t=this.state.registeredVariables[e];this.disposeVariable(t)}}disposeVariable(e){this.disposeTensor(e),null!=this.state.registeredVariables[e.name]&&delete this.state.registeredVariables[e.name]}memory(){const e=this.backend.memory();return e.numTensors=this.state.numTensors,e.numDataBuffers=this.state.numDataBuffers,e.numBytes=this.state.numBytes,this.state.numStringTensors>0&&(e.unreliable=!0,null==e.reasons&&(e.reasons=[]),e.reasons.push("Memory usage by string tensors is approximate (2 bytes per character)")),e}async profile(e){this.state.profiling=!0;const t=this.state.numBytes,n=this.state.numTensors;this.state.activeProfile.kernels=[],this.state.activeProfile.result=await e(),this.state.profiling=!1,this.state.activeProfile.peakBytes=Math.max(...this.state.activeProfile.kernels.map((e=>e.totalBytesSnapshot))),this.state.activeProfile.newBytes=this.state.numBytes-t,this.state.activeProfile.newTensors=this.state.numTensors-n;for(const e of this.state.activeProfile.kernels)e.kernelTimeMs=await e.kernelTimeMs,e.extraInfo=await e.extraInfo;return this.state.activeProfile}isTapeOn(){return this.state.gradientDepth>0&&0===this.state.kernelDepth}addTapeNode(e,t,n,a,i,s){const r={id:this.state.nextTapeNodeId++,kernelName:e,inputs:t,outputs:n,saved:i},o=mt(e);null!=o&&(a=o.gradFunc),null!=a&&(r.gradient=e=>(e=e.map(((e,t)=>{if(null==e){const e=n[t],a=P(e.size,e.dtype);return this.makeTensor(a,e.shape,e.dtype)}return e})),a(e.length>1?e:e[0],i,s))),this.state.activeTape.push(r)}keep(e){return e.kept=!0,e}startTape(){0===this.state.gradientDepth&&(this.state.activeTape=[]),this.state.gradientDepth++}endTape(){this.state.gradientDepth--}startScope(e){const t={track:[],name:"unnamed scope",id:this.state.nextScopeId++};e&&(t.name=e),this.state.scopeStack.push(t),this.state.activeScope=t}endScope(e){const t=Yt(e),n=new Set(t.map((e=>e.id)));for(let e=0;e<this.state.activeScope.track.length;e++){const t=this.state.activeScope.track[e];t.kept||n.has(t.id)||t.dispose()}const a=this.state.scopeStack.pop();this.state.activeScope=0===this.state.scopeStack.length?null:this.state.scopeStack[this.state.scopeStack.length-1],t.forEach((e=>{e.kept||e.scopeId!==a.id||this.track(e)}))}gradients(e,t,n,a=!1){if(x(t.length>0,(()=>"gradients() received an empty list of xs.")),null!=n&&"float32"!==n.dtype)throw new Error(`dy must have 'float32' dtype, but has '${n.dtype}'`);const i=this.scopedRun((()=>this.startTape()),(()=>this.endTape()),(()=>this.tidy("forward",e)));x(i instanceof Mt,(()=>"The result y returned by f() must be a tensor."));const s=function(e,t,n){const a={},i={};for(let e=0;e<t.length;e++)a[t[e].id]=!0;for(let n=0;n<e.length;n++){const s=e[n],r=s.inputs;for(const e in r){const n=r[e];let o=!1;for(let e=0;e<t.length;e++)if(a[n.id]){s.outputs.forEach((e=>a[e.id]=!0)),o=!0,i[s.id]=!0;break}if(o)break}}const s={};s[n.id]=!0;const r={};for(let t=e.length-1;t>=0;t--){const n=e[t],a=n.inputs;for(let e=0;e<n.outputs.length;e++)if(s[n.outputs[e].id]){for(const e in a)s[a[e].id]=!0,r[n.id]=!0;break}}const o=[];for(let t=0;t<e.length;t++){const n=e[t];if(i[n.id]&&r[n.id]){const e={};for(const t in n.inputs){const i=n.inputs[t];a[i.id]&&(e[t]=i)}const t=Object.assign({},n);t.inputs=e,t.outputs=n.outputs,o.push(t)}}return o}(this.state.activeTape,t,i);if(!a&&0===s.length&&t.length>0)throw new Error("Cannot compute gradient of y=f(x) with respect to x. Make sure that the f you passed encloses all operations that lead from x to y.");return this.tidy("backward",(()=>{const e={};e[i.id]=null==n?function(e){const t=O(N(e),"float32");return an.makeTensor(t,e,"float32")}(i.shape):n,function(e,t,n,a){for(let i=t.length-1;i>=0;i--){const s=t[i],r=[];if(s.outputs.forEach((t=>{const n=e[t.id];null!=n?r.push(n):r.push(null)})),null==s.gradient)throw new Error(`Cannot compute gradient: gradient function not found for ${s.kernelName}.`);const o=s.gradient(r);for(const t in s.inputs){if(!(t in o))throw new Error(`Cannot backprop through input ${t}. Available gradients found: ${Object.keys(o)}.`);const i=n((()=>o[t]()));if("float32"!==i.dtype)throw new Error(`Error in gradient for op ${s.kernelName}. The gradient of input ${t} must have 'float32' dtype, but has '${i.dtype}'`);const r=s.inputs[t];if(!T(i.shape,r.shape))throw new Error(`Error in gradient for op ${s.kernelName}. The gradient of input '${t}' has shape '${i.shape}', which does not match the shape of the input '${r.shape}'`);if(null==e[r.id])e[r.id]=i;else{const t=e[r.id];e[r.id]=a(t,i),t.dispose()}}}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(e,s,(e=>this.tidy(e)),sn);const a=t.map((t=>e[t.id]));return 0===this.state.gradientDepth&&(this.state.activeTape.forEach((e=>{for(const t of e.saved)t.dispose()})),this.state.activeTape=null),{value:i,grads:a}}))}customGrad(e){return x(_(e),(()=>"The f passed in customGrad(f) must be a function.")),(...t)=>{let n;x(t.every((e=>e instanceof Mt)),(()=>"The args passed in customGrad(f)(x1, x2,...) must all be tensors"));const a={};t.forEach(((e,t)=>{a[t]=e}));return this.runKernelFunc({forwardFunc:(a,i)=>(n=e(...t,i),x(n.value instanceof Mt,(()=>"The function f passed in customGrad(f) must return an object where `obj.value` is a tensor")),x(_(n.gradFunc),(()=>"The function f passed in customGrad(f) must return an object where `obj.gradFunc` is a function.")),n.value),backwardsFunc:(e,a)=>{const i=n.gradFunc(e,a),s=Array.isArray(i)?i:[i];x(s.length===t.length,(()=>"The function f passed in customGrad(f) must return an object where `obj.gradFunc` is a function that returns the same number of tensors as inputs passed to f(...).")),x(s.every((e=>e instanceof Mt)),(()=>"The function f passed in customGrad(f) must return an object where `obj.gradFunc` is a function that returns a list of only tensors."));const r={};return s.forEach(((e,t)=>{r[t]=()=>e})),r},inputs:a})}}readSync(e){return this.state.tensorInfo.get(e).backend.readSync(e)}read(e){return this.state.tensorInfo.get(e).backend.read(e)}readToGPU(e,t){return this.state.tensorInfo.get(e).backend.readToGPU(e,t)}async time(e){const t=xt(),n=await this.backend.time(e);return n.wallMs=xt()-t,n}track(e){return null!=this.state.activeScope&&(e.scopeId=this.state.activeScope.id,this.state.activeScope.track.push(e)),e}get registeredVariables(){return this.state.registeredVariables}reset(){this.pendingBackendInitId++,this.state.dispose(),this.ENV.reset(),this.state=new en;for(const e in this.registry)this.disposeRegisteredKernels(e),this.registry[e].dispose(),delete this.registry[e];this.backendName=null,this.backendInstance=null,this.pendingBackendInit=null}}function nn(){const e=Y();if(null==e._tfengine){const t=new K(e);e._tfengine=new tn(t)}var t;
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */return t=e._tfengine.ENV,Z=t,Rt=()=>e._tfengine,e._tfengine}tn.nextTensorId=0,tn.nextVariableId=0;const an=nn();function sn(e,t){const n={a:e,b:t};return an.runKernel(X,n)}
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const rn=H();
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function on(e,t){let n=e;if(Tt(e))return"string"===t?[]:[e.length];if(Ht(e)){const t=e.channels||"RGBA";return[e.height,e.width*t.length]}if(Jt(e))return[e.buffer.size/(null==t?4:j(t))];if(!Array.isArray(e))return[];const a=[];for(;Array.isArray(n)||Tt(n)&&"string"!==t;)a.push(n.length),n=n[0];return Array.isArray(e)&&H().getBool("TENSORLIKE_CHECK_SHAPE_CONSISTENCY")&&ln(e,a,[]),a}function ln(e,t,n){if(n=n||[],!Array.isArray(e)&&!Tt(e))return void x(0===t.length,(()=>`Element arr[${n.join("][")}] is a primitive, but should be an array/TypedArray of ${t[0]} elements`));x(t.length>0,(()=>`Element arr[${n.join("][")}] should be a primitive, but is an array of ${e.length} elements`)),x(e.length===t[0],(()=>`Element arr[${n.join("][")}] should have ${t[0]} elements, but has ${e.length} elements`));const a=t.slice(1);for(let t=0;t<e.length;++t)ln(e[t],a,n.concat(t))}function cn(e,t,n,a){if("string_or_numeric"!==e){if(null==e)throw new Error("Expected dtype cannot be null.");if("numeric"!==e&&e!==t||"numeric"===e&&"string"===t)throw new Error(`Argument '${n}' passed to '${a}' must be ${e} tensor, but got ${t} tensor`)}}function un(e,t,n,a="numeric"){if(e instanceof Ot())return cn(a,e.dtype,t,n),e;let i=F(e);if("string"!==i&&["bool","int32","float32"].indexOf(a)>=0&&(i=a),cn(a,i,t,n),null==e||!Tt(e)&&!Array.isArray(e)&&"number"!=typeof e&&"boolean"!=typeof e&&"string"!=typeof e){const a=null==e?"null":e.constructor.name;throw new Error(`Argument '${t}' passed to '${n}' must be a Tensor or TensorLike, but got '${a}'`)}const s=on(e,i);Tt(e)||Array.isArray(e)||(e=[e]);const r="string"!==i?kt(e,i):It(e,[],!0);return an.makeTensor(r,s,i)}function hn(e,t,n,a="numeric"){if(!Array.isArray(e))throw new Error(`Argument ${t} passed to ${n} must be a \`Tensor[]\` or \`TensorLike[]\``);return e.map(((e,i)=>un(e,`${t}[${i}]`,n,a)))}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */rn.registerFlag("DEBUG",(()=>!1),(e=>{e&&console.warn("Debugging mode is ON. The output of every math call will be downloaded to CPU and checked for NaNs. This significantly impacts performance.")})),rn.registerFlag("IS_BROWSER",(()=>"undefined"!=typeof window&&null!=window.document||"undefined"!=typeof WorkerGlobalScope)),rn.registerFlag("IS_NODE",(()=>"undefined"!=typeof process&&void 0!==process.versions&&void 0!==process.versions.node)),rn.registerFlag("IS_CHROME",(()=>"undefined"!=typeof navigator&&null!=navigator&&null!=navigator.userAgent&&/Chrome/.test(navigator.userAgent)&&/Google Inc/.test(navigator.vendor))),rn.registerFlag("IS_SAFARI",(()=>"undefined"!=typeof navigator&&null!=navigator&&null!=navigator.userAgent&&/Safari/.test(navigator.userAgent)&&/Apple/.test(navigator.vendor))),rn.registerFlag("PROD",(()=>!1)),rn.registerFlag("TENSORLIKE_CHECK_SHAPE_CONSISTENCY",(()=>rn.getBool("DEBUG"))),rn.registerFlag("DEPRECATION_WARNINGS_ENABLED",(()=>!0)),rn.registerFlag("IS_TEST",(()=>!1)),rn.registerFlag("CHECK_COMPUTATION_FOR_ERRORS",(()=>rn.getBool("DEBUG"))),rn.registerFlag("WRAP_TO_IMAGEBITMAP",(()=>!1)),rn.registerFlag("CANVAS2D_WILL_READ_FREQUENTLY_FOR_GPU",(()=>!1)),rn.registerFlag("USE_SETTIMEOUTCUSTOM",(()=>!1));function pn(e){const t=Object.keys(e);if(1!==t.length)throw new Error(`Please provide an object with a single key (operation name) mapping to a function. Got an object with ${t.length} keys.`);let n=t[0];const a=e[n];n.endsWith("_")&&(n=n.substring(0,n.length-1)),n+="__op";const i=(...e)=>{an.startScope(n);try{const t=a(...e);return G(t)&&console.error("Cannot return a Promise inside of tidy."),an.endScope(t),t}catch(e){throw an.endScope(null),e}};return Object.defineProperty(i,"name",{value:n,configurable:!0}),i}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const dn=pn({complex_:function(e,t){const n=un(e,"real","complex"),a=un(t,"imag","complex");!function(e,t,n=""){x(T(e,t),(()=>n+` Shapes ${e} and ${t} must match`))}(n.shape,a.shape,`real and imag shapes, ${n.shape} and ${a.shape}, must match in call to tf.complex().`);const i={real:n,imag:a};return an.runKernel("Complex",i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function fn(e,t,n,a){if(null==a)a=F(e);else if("complex64"===a)throw new Error("Cannot construct a complex64 tensor directly. Please use tf.complex(real, imag).");if(Jt(e)||Ht(e)){if("float32"!==a&&"int32"!==a)throw new Error(`Creating tensor from GPU data only supports 'float32'|'int32' dtype, while the dtype is ${a}.`);return an.backend.createTensorFromGPUData(e,t||n,a)}if(!Tt(e)&&!Array.isArray(e)&&"number"!=typeof e&&"boolean"!=typeof e&&"string"!=typeof e)throw new Error("values passed to tensor(values) must be a number/boolean/string or an array of numbers/booleans/strings, or a TypedArray");if(null!=t){B(t);const e=N(t),a=N(n);x(e===a,(()=>`Based on the provided shape, [${t}], the tensor should have ${e} values but has ${a}`));for(let e=0;e<n.length;++e){const a=n[e],i=e!==n.length-1||a!==N(t.slice(e));x(n[e]===t[e]||!i,(()=>`Error creating a new Tensor. Inferred shape (${n}) does not match the provided shape (${t}). `))}}return Tt(e)||Array.isArray(e)||(e=[e]),t=t||n,e="string"!==a?kt(e,a):It(e,[],!0),an.makeTensor(e,t,a)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function mn(e,t,n){return fn(e,t,on(e,n),n)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const gn={float32:4,float16:2,int32:4,uint16:2,uint8:1,bool:1,complex64:8};class vn{static join(e){return new vn(e).slice()}constructor(e){if(this.shards=[],this.previousShardIndex=0,null==e)return;if(e instanceof Array||(e=[e]),0===(e=e.map((e=>Tt(e)?e.buffer:e))).length)return;this.bufferUniformSize=e[0].byteLength;let t=0;for(let n=0;n<e.length;n++){const a=e[n];n!==e.length-1&&a.byteLength!==this.bufferUniformSize&&(this.bufferUniformSize=void 0);const i=t+a.byteLength;this.shards.push({buffer:a,start:t,end:i}),t=i}0===this.shards.length&&(this.byteLength=0),this.byteLength=this.shards[this.shards.length-1].end}slice(e=0,t=this.byteLength){if(0===this.shards.length)return new ArrayBuffer(0);if(e=isNaN(Number(e))?0:e,t=isNaN(Number(t))?0:t,e=Math.max(0,e),(t=Math.min(this.byteLength,t))<=e)return new ArrayBuffer(0);const n=this.findShardForByte(e);if(-1===n)throw new Error(`Could not find start shard for byte ${e}`);const a=new ArrayBuffer(t-e),i=new Uint8Array(a);let s=0;for(let a=n;a<this.shards.length;a++){const n=this.shards[a],r=e+s-n.start,o=s,l=Math.min(t,n.end)-n.start,c=new Uint8Array(n.buffer,r,l-r);if(i.set(c,o),s+=c.length,t<n.end)break}return a}findShardForByte(e){if(0===this.shards.length||e<0||e>=this.byteLength)return-1;if(null!=this.bufferUniformSize)return this.previousShardIndex=Math.floor(e/this.bufferUniformSize),this.previousShardIndex;function t(t){return e<t.start?-1:e>=t.end?1:0}if(0===t(this.shards[this.previousShardIndex]))return this.previousShardIndex;const n=function(e,t){let n=0,a=e.length;for(;n<=a;){const i=Math.floor((a-n)/2)+n,s=t(e[i]);if(0===s)return i;s<0?a=i:n=i+1}return-1}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(this.shards,t);return-1===n?-1:(this.previousShardIndex=n,this.previousShardIndex)}}function yn(){return an}function bn(){return an.memory()}function wn(e,t){return an.tidy(e,t)}function kn(e){Yt(e).forEach((e=>e.dispose()))}function xn(e){return an.keep(e)}async function Sn(e,t){const n=[],a=[],i=Array.isArray(e)?e.map((e=>e.name)):Object.keys(e);for(let s=0;s<i.length;++s){const r=i[s],o=Array.isArray(e)?e[s].tensor:e[r];if("float32"!==o.dtype&&"int32"!==o.dtype&&"bool"!==o.dtype&&"string"!==o.dtype&&"complex64"!==o.dtype)throw new Error(`Unsupported dtype in weight '${r}': ${o.dtype}`);const l={name:r,shape:o.shape,dtype:o.dtype};if("string"===o.dtype){const e=new Promise((async e=>{const t=await o.bytes(),n=t.reduce(((e,t)=>e+t.length),0)+4*t.length,a=new Uint8Array(n);let i=0;for(let e=0;e<t.length;e++){const n=t[e],s=new Uint8Array(new Uint32Array([n.length]).buffer);a.set(s,i),i+=4,a.set(n,i),i+=n.length}e(a)}));a.push(e)}else a.push(o.data());null!=t&&(l.group=t),n.push(l)}return{data:In(await Promise.all(a)),specs:n}}function Nn(e,t){const n=N(e.shape);let a;if("quantization"in e){const t=e.quantization;a=gn[t.dtype]}else{if("string"===e.dtype){let e=0;for(let a=0;a<n;a++)e+=4+new Uint32Array(t(e,e+4))[0];return e}a=gn[e.dtype]}return n*a}function Tn(e,t){const n=e.name,a=e.dtype,i=e.shape,s=N(i);let r,o=0;if("quantization"in e){const i=e.quantization;if("uint8"===i.dtype||"uint16"===i.dtype){if(!("min"in i)||!("scale"in i))throw new Error(`Weight ${e.name} with quantization ${i.dtype} doesn't have corresponding metadata min and scale.`)}else{if("float16"!==i.dtype)throw new Error(`Weight ${e.name} has unknown quantization dtype ${i.dtype}. Supported quantization dtypes are: 'uint8', 'uint16', and 'float16'.`);if("float32"!==a)throw new Error(`Weight ${e.name} is quantized with ${i.dtype} which only supports weights of type float32 not ${a}.`)}const l=gn[i.dtype],c="uint8"===i.dtype?new Uint8Array(t):new Uint16Array(t);if("float32"===a)if("uint8"===i.dtype||"uint16"===i.dtype){r=new Float32Array(c.length);for(let e=0;e<c.length;e++){const t=c[e];r[e]=t*i.scale+i.min}}else{if("float16"!==i.dtype)throw new Error(`Unsupported quantization type ${i.dtype} for weight type float32.`);{const e=function(){const e=function(){const e=e=>{let t=e<<13,n=0;for(;!(8388608&t);)n-=8388608,t<<=1;return t&=-8388609,n+=947912704,t|n},t=new Uint32Array(2048);t[0]=0;for(let n=1;n<1024;n++)t[n]=e(n);for(let e=1024;e<2048;e++)t[e]=939524096+(e-1024<<13);return t}(),t=function(){const e=new Uint32Array(64);e[0]=0,e[31]=1199570944,e[32]=2147483648,e[63]=3347054592;for(let t=1;t<31;t++)e[t]=t<<23;for(let t=33;t<63;t++)e[t]=2147483648+(t-32<<23);return e}(),n=function(){const e=new Uint32Array(64);for(let t=0;t<64;t++)e[t]=1024;return e[0]=e[32]=0,e}();return a=>{const i=new ArrayBuffer(4*a.length),s=new Uint32Array(i);for(let i=0;i<a.length;i++){const r=a[i],o=e[n[r>>10]+(1023&r)]+t[r>>10];s[i]=o}return new Float32Array(i)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */();r=e(c)}}else{if("int32"!==a)throw new Error(`Unsupported dtype in weight '${n}': ${a}`);if("uint8"!==i.dtype&&"uint16"!==i.dtype)throw new Error(`Unsupported quantization type ${i.dtype} for weight type int32.`);r=new Int32Array(c.length);for(let e=0;e<c.length;e++){const t=c[e];r[e]=Math.round(t*i.scale+i.min)}}o+=s*l}else if("string"===a){const n=N(e.shape);r=[];for(let e=0;e<n;e++){const e=new Uint32Array(t.slice(o,o+4))[0];o+=4;const n=new Uint8Array(t.slice(o,o+e));r.push(n),o+=e}}else{const e=gn[a];if("float32"===a)r=new Float32Array(t);else if("int32"===a)r=new Int32Array(t);else{if("bool"!==a){if("complex64"===a){r=new Float32Array(t);const e=new Float32Array(r.length/2),n=new Float32Array(r.length/2);for(let t=0;t<e.length;t++)e[t]=r[2*t],n[t]=r[2*t+1];const a=mn(e,i,"float32"),s=mn(n,i,"float32"),o=dn(a,s);return a.dispose(),s.dispose(),o}throw new Error(`Unsupported dtype in weight '${n}': ${a}`)}r=new Uint8Array(t)}o+=s*e}return mn(r,i,a)}function In(e){if(null===e)throw new Error(`Invalid input value: ${JSON.stringify(e)}`);let t=0;const n=[];e.forEach((e=>{if(t+=e.byteLength,n.push(e.byteLength===e.buffer.byteLength?e:new e.constructor(e)),!(e instanceof Float32Array||e instanceof Int32Array||e instanceof Uint8Array))throw new Error(`Unsupported TypedArray subtype: ${e.constructor.name}`)}));const a=new Uint8Array(t);let i=0;return n.forEach((e=>{a.set(new Uint8Array(e.buffer),i),i+=e.byteLength})),a.buffer}const Cn="undefined"!=typeof Buffer&&("undefined"==typeof Blob||"undefined"==typeof atob||"undefined"==typeof btoa);function $n(e){return Cn?Buffer.byteLength(e,"utf8"):new Blob([e]).size}async function An(e,t){let n,a;return null!=e.weightsManifest&&([n,a]=await t(e.weightsManifest)),function(e,t,n){const a={modelTopology:e.modelTopology,format:e.format,generatedBy:e.generatedBy,convertedBy:e.convertedBy};if(null!=e.trainingConfig&&(a.trainingConfig=e.trainingConfig),null!=e.weightsManifest){if(!t)throw new Error("modelJSON has weightsManifest but weightSpecs is null");if(!n)throw new Error("modelJSON has weightsManifest but weightData is null");a.weightSpecs=t,a.weightData=n}return null!=e.signature&&(a.signature=e.signature),null!=e.userDefinedMetadata&&(a.userDefinedMetadata=e.userDefinedMetadata),null!=e.modelInitializer&&(a.modelInitializer=e.modelInitializer),null!=e.initializerSignature&&(a.initializerSignature=e.initializerSignature),a}(e,n,a)}function En(e){if(e.modelTopology instanceof ArrayBuffer)throw new Error("Expected JSON model topology, received ArrayBuffer.");return{dateSaved:new Date,modelTopologyType:"JSON",modelTopologyBytes:null==e.modelTopology?0:$n(JSON.stringify(e.modelTopology)),weightSpecsBytes:null==e.weightSpecs?0:$n(JSON.stringify(e.weightSpecs)),weightDataBytes:null==e.weightData?0:new vn(e.weightData).byteLength}}function jn(e){const t=[];for(const n of e)t.push(...n.weights);return t}class zn{constructor(){this.saveRouters=[],this.loadRouters=[]}static getInstance(){return null==zn.instance&&(zn.instance=new zn),zn.instance}static registerSaveRouter(e){zn.getInstance().saveRouters.push(e)}static registerLoadRouter(e){zn.getInstance().loadRouters.push(e)}static getSaveHandlers(e){return zn.getHandlers(e,"save")}static getLoadHandlers(e,t){return zn.getHandlers(e,"load",t)}static getHandlers(e,t,n){const a=[];return("load"===t?zn.getInstance().loadRouters:zn.getInstance().saveRouters).forEach((t=>{const i=t(e,n);null!==i&&a.push(i)})),a}}const Dn="tensorflowjs",Fn="models_store",_n="model_info_store";function Rn(){if(!H().getBool("IS_BROWSER"))throw new Error("Failed to obtain IndexedDB factory because the current environmentis not a web browser.");const e="undefined"==typeof window?self:window,t=e.indexedDB||e.mozIndexedDB||e.webkitIndexedDB||e.msIndexedDB||e.shimIndexedDB;if(null==t)throw new Error("The current browser does not appear to support IndexedDB.");return t}function Ln(e){const t=e.result;t.createObjectStore(Fn,{keyPath:"modelPath"}),t.createObjectStore(_n,{keyPath:"modelPath"})}class Mn{constructor(e){if(this.indexedDB=Rn(),null==e||!e)throw new Error("For IndexedDB, modelPath must not be null, undefined or empty.");this.modelPath=e}async save(e){if(e.modelTopology instanceof ArrayBuffer)throw new Error("BrowserLocalStorage.save() does not support saving model topology in binary formats yet.");return this.databaseAction(this.modelPath,e)}async load(){return this.databaseAction(this.modelPath)}databaseAction(e,t){return new Promise(((e,n)=>{const a=this.indexedDB.open(Dn,1);a.onupgradeneeded=()=>Ln(a),a.onsuccess=()=>{const i=a.result;if(null==t){const t=i.transaction(Fn,"readonly"),a=t.objectStore(Fn).get(this.modelPath);a.onsuccess=()=>{if(null==a.result)return i.close(),n(new Error(`Cannot find model with path '${this.modelPath}' in IndexedDB.`));e(a.result.modelArtifacts)},a.onerror=e=>(i.close(),n(a.error)),t.oncomplete=()=>i.close()}else{t.weightData=vn.join(t.weightData);const a=En(t),s=i.transaction(_n,"readwrite");let r,o,l=s.objectStore(_n);try{r=l.put({modelPath:this.modelPath,modelArtifactsInfo:a})}catch(e){return n(e)}r.onsuccess=()=>{o=i.transaction(Fn,"readwrite");const r=o.objectStore(Fn);let c;try{c=r.put({modelPath:this.modelPath,modelArtifacts:t,modelArtifactsInfo:a})}catch(e){return n(e)}c.onsuccess=()=>e({modelArtifactsInfo:a}),c.onerror=e=>{l=s.objectStore(_n);const t=l.delete(this.modelPath);t.onsuccess=()=>(i.close(),n(c.error)),t.onerror=e=>(i.close(),n(c.error))}},r.onerror=e=>(i.close(),n(r.error)),s.oncomplete=()=>{null==o?i.close():o.oncomplete=()=>i.close()}}},a.onerror=e=>n(a.error)}))}}Mn.URL_SCHEME="indexeddb://";const On=e=>{return H().getBool("IS_BROWSER")&&!Array.isArray(e)&&e.startsWith(Mn.URL_SCHEME)?(t=e.slice(Mn.URL_SCHEME.length),new Mn(t)):null;var t};zn.registerSaveRouter(On),zn.registerLoadRouter(On);class Pn{constructor(){this.indexedDB=Rn()}async listModels(){return new Promise(((e,t)=>{const n=this.indexedDB.open(Dn,1);n.onupgradeneeded=()=>Ln(n),n.onsuccess=()=>{const a=n.result,i=a.transaction(_n,"readonly"),s=i.objectStore(_n).getAll();s.onsuccess=()=>{const t={};for(const e of s.result)t[e.modelPath]=e.modelArtifactsInfo;e(t)},s.onerror=e=>(a.close(),t(s.error)),i.oncomplete=()=>a.close()},n.onerror=e=>t(n.error)}))}async removeModel(e){var t;return e=(t=e).startsWith(Mn.URL_SCHEME)?t.slice(Mn.URL_SCHEME.length):t,new Promise(((t,n)=>{const a=this.indexedDB.open(Dn,1);a.onupgradeneeded=()=>Ln(a),a.onsuccess=()=>{const i=a.result,s=i.transaction(_n,"readwrite"),r=s.objectStore(_n),o=r.get(e);let l;o.onsuccess=()=>{if(null==o.result)return i.close(),n(new Error(`Cannot find model with path '${e}' in IndexedDB.`));{const a=r.delete(e),s=()=>{l=i.transaction(Fn,"readwrite");const a=l.objectStore(Fn).delete(e);a.onsuccess=()=>t(o.result.modelArtifactsInfo),a.onerror=e=>n(o.error)};a.onsuccess=s,a.onerror=e=>(s(),i.close(),n(o.error))}},o.onerror=e=>(i.close(),n(o.error)),s.oncomplete=()=>{null==l?i.close():l.oncomplete=()=>i.close()}},a.onerror=e=>n(a.error)}))}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Bn="/",Un="tensorflowjs_models",Wn="info",Gn="model_topology",Vn="weight_specs",Kn="weight_data",qn="model_metadata";function Hn(e){return{info:[Un,e,Wn].join(Bn),topology:[Un,e,Gn].join(Bn),weightSpecs:[Un,e,Vn].join(Bn),weightData:[Un,e,Kn].join(Bn),modelMetadata:[Un,e,qn].join(Bn)}}function Jn(e){for(const t of Object.values(e))window.localStorage.removeItem(t)}function Zn(e){const t=e.split(Bn);if(t.length<3)throw new Error(`Invalid key format: ${e}`);return t.slice(1,t.length-1).join(Bn)}class Yn{constructor(e){if(!H().getBool("IS_BROWSER")||"undefined"==typeof window||void 0===window.localStorage)throw new Error("The current environment does not support local storage.");if(this.LS=window.localStorage,null==e||!e)throw new Error("For local storage, modelPath must not be null, undefined or empty.");this.modelPath=e,this.keys=Hn(this.modelPath)}async save(e){if(e.modelTopology instanceof ArrayBuffer)throw new Error("BrowserLocalStorage.save() does not support saving model topology in binary formats yet.");{const t=JSON.stringify(e.modelTopology),n=JSON.stringify(e.weightSpecs),a=En(e),i=vn.join(e.weightData);try{this.LS.setItem(this.keys.info,JSON.stringify(a)),this.LS.setItem(this.keys.topology,t),this.LS.setItem(this.keys.weightSpecs,n),this.LS.setItem(this.keys.weightData,function(e){if(Cn)return Buffer.from(e).toString("base64");const t=new Uint8Array(e);let n="";for(let e=0,a=t.length;e<a;e++)n+=String.fromCharCode(t[e]);return btoa(n)}(i));const s={format:e.format,generatedBy:e.generatedBy,convertedBy:e.convertedBy,signature:null!=e.signature?e.signature:void 0,userDefinedMetadata:null!=e.userDefinedMetadata?e.userDefinedMetadata:void 0,modelInitializer:null!=e.modelInitializer?e.modelInitializer:void 0,initializerSignature:null!=e.initializerSignature?e.initializerSignature:void 0,trainingConfig:null!=e.trainingConfig?e.trainingConfig:void 0};return this.LS.setItem(this.keys.modelMetadata,JSON.stringify(s)),{modelArtifactsInfo:a}}catch(e){throw Jn(this.keys),new Error(`Failed to save model '${this.modelPath}' to local storage: size quota being exceeded is a possible cause of this failure: modelTopologyBytes=${a.modelTopologyBytes}, weightSpecsBytes=${a.weightSpecsBytes}, weightDataBytes=${a.weightDataBytes}.`)}}}async load(){const e=JSON.parse(this.LS.getItem(this.keys.info));if(null==e)throw new Error(`In local storage, there is no model with name '${this.modelPath}'`);if("JSON"!==e.modelTopologyType)throw new Error("BrowserLocalStorage does not support loading non-JSON model topology yet.");const t={},n=JSON.parse(this.LS.getItem(this.keys.topology));if(null==n)throw new Error(`In local storage, the topology of model '${this.modelPath}' is missing.`);t.modelTopology=n;const a=JSON.parse(this.LS.getItem(this.keys.weightSpecs));if(null==a)throw new Error(`In local storage, the weight specs of model '${this.modelPath}' are missing.`);t.weightSpecs=a;const i=this.LS.getItem(this.keys.modelMetadata);if(null!=i){const e=JSON.parse(i);t.format=e.format,t.generatedBy=e.generatedBy,t.convertedBy=e.convertedBy,null!=e.signature&&(t.signature=e.signature),null!=e.userDefinedMetadata&&(t.userDefinedMetadata=e.userDefinedMetadata),null!=e.modelInitializer&&(t.modelInitializer=e.modelInitializer),null!=e.initializerSignature&&(t.initializerSignature=e.initializerSignature),null!=e.trainingConfig&&(t.trainingConfig=e.trainingConfig)}const s=this.LS.getItem(this.keys.weightData);if(null==s)throw new Error(`In local storage, the binary weight values of model '${this.modelPath}' are missing.`);return t.weightData=function(e){if(Cn){const t=Buffer.from(e,"base64");return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)}const t=atob(e),n=new Uint8Array(t.length);for(let e=0;e<t.length;++e)n.set([t.charCodeAt(e)],e);return n.buffer}(s),t}}Yn.URL_SCHEME="localstorage://";const Qn=e=>{return H().getBool("IS_BROWSER")&&!Array.isArray(e)&&e.startsWith(Yn.URL_SCHEME)?(t=e.slice(Yn.URL_SCHEME.length),new Yn(t)):null;var t};zn.registerSaveRouter(Qn),zn.registerLoadRouter(Qn);class Xn{constructor(){x(H().getBool("IS_BROWSER"),(()=>"Current environment is not a web browser")),x("undefined"==typeof window||void 0!==window.localStorage,(()=>"Current browser does not appear to support localStorage")),this.LS=window.localStorage}async listModels(){const e={},t=Un+Bn,n=Bn+Wn;for(let a=0;a<this.LS.length;++a){const i=this.LS.key(a);if(i.startsWith(t)&&i.endsWith(n)){e[Zn(i)]=JSON.parse(this.LS.getItem(i))}}return e}async removeModel(e){var t;const n=Hn(e=(t=e).startsWith(Yn.URL_SCHEME)?t.slice(Yn.URL_SCHEME.length):t);if(null==this.LS.getItem(n.info))throw new Error(`Cannot find model at path '${e}'`);const a=JSON.parse(this.LS.getItem(n.info));return Jn(n),a}}
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function ea(e,t,n,a){!function(e){x(null!=e&&Array.isArray(e)&&e.length>0,(()=>"promises must be a none empty array"))}(e),function(e,t){x(e>=0&&e<=1,(()=>`Progress fraction must be in range [0, 1], but got startFraction ${e}`)),x(t>=0&&t<=1,(()=>`Progress fraction must be in range [0, 1], but got endFraction ${t}`)),x(t>=e,(()=>`startFraction must be no more than endFraction, but got startFraction ${e} and endFraction ${t}`))}(n=null==n?0:n,a=null==a?1:a);let i=0;return Promise.all(e.map((s=>(s.then((s=>{const r=n+ ++i/e.length*(a-n);return t(r),s})),s))))}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class ta{constructor(e,t){if(this.DEFAULT_METHOD="POST",null==t&&(t={}),this.weightPathPrefix=t.weightPathPrefix,this.weightUrlConverter=t.weightUrlConverter,null!=t.fetchFunc?(x("function"==typeof t.fetchFunc,(()=>"Must pass a function that matches the signature of `fetch` (see https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)")),this.fetch=t.fetchFunc):this.fetch=H().platform.fetch,x(null!=e&&e.length>0,(()=>"URL path for http must not be null, undefined or empty.")),Array.isArray(e)&&x(2===e.length,(()=>`URL paths for http must have a length of 2, (actual length is ${e.length}).`)),this.path=e,null!=t.requestInit&&null!=t.requestInit.body)throw new Error("requestInit is expected to have no pre-existing body, but has one.");this.requestInit=t.requestInit||{},this.loadOptions=t}async save(e){if(e.modelTopology instanceof ArrayBuffer)throw new Error("BrowserHTTPRequest.save() does not support saving model topology in binary formats yet.");const t=Object.assign({method:this.DEFAULT_METHOD},this.requestInit);t.body=new FormData;const n=function(e,t){const n={modelTopology:e.modelTopology,format:e.format,generatedBy:e.generatedBy,convertedBy:e.convertedBy,weightsManifest:t};return null!=e.signature&&(n.signature=e.signature),null!=e.userDefinedMetadata&&(n.userDefinedMetadata=e.userDefinedMetadata),null!=e.modelInitializer&&(n.modelInitializer=e.modelInitializer),null!=e.initializerSignature&&(n.initializerSignature=e.initializerSignature),null!=e.trainingConfig&&(n.trainingConfig=e.trainingConfig),n}(e,[{paths:["./model.weights.bin"],weights:e.weightSpecs}]);if(t.body.append("model.json",new Blob([JSON.stringify(n)],{type:"application/json"}),"model.json"),null!=e.weightData){const n=vn.join(e.weightData);t.body.append("model.weights.bin",new Blob([n],{type:"application/octet-stream"}),"model.weights.bin")}const a=await this.fetch(this.path,t);if(a.ok)return{modelArtifactsInfo:En(e),responses:[a]};throw new Error(`BrowserHTTPRequest.save() failed due to HTTP response status ${a.status}.`)}async loadModelJSON(){const e=await this.fetch(this.path,this.requestInit);if(!e.ok)throw new Error(`Request to ${this.path} failed with status code ${e.status}. Please verify this URL points to the model JSON of the model to load.`);let t;try{t=await e.json()}catch(e){let t=`Failed to parse model JSON of response from ${this.path}.`;throw this.path.endsWith(".pb")?t+=" Your path contains a .pb file extension. Support for .pb models have been removed in TensorFlow.js 1.0 in favor of .json models. You can re-convert your Python TensorFlow model using the TensorFlow.js 1.0 conversion scripts or you can convert your.pb models with the 'pb2json'NPM script in the tensorflow/tfjs-converter repository.":t+=" Please make sure the server is serving valid JSON for this request.",new Error(t)}const n=t.modelTopology,a=t.weightsManifest;if(null==n&&null==a)throw new Error(`The JSON from HTTP path ${this.path} contains neither model topology or manifest for weights.`);return t}async load(){if(this.loadOptions.streamWeights)return this.loadStream();return An(await this.loadModelJSON(),(e=>this.loadWeights(e)))}async loadStream(){const e=await this.loadModelJSON(),t=await this.getWeightUrls(e.weightsManifest),n=jn(e.weightsManifest);return Object.assign(Object.assign({},e),{weightSpecs:n,getWeightStream:()=>function(e,t){var n;const a=null==t.fetchFunc?H().platform.fetch:t.fetchFunc;let i,s=0;return null===(n=t.onProgress)||void 0===n||n.call(t,0),new ReadableStream({pull:async n=>{for(var r;s<e.length;){if(!i){const n=(await a(e[s],t.requestInit,{isBinary:!0})).body;i=n.getReader()}const{done:o,value:l}=await i.read();if(!o)return void n.enqueue(l);s++,i=void 0,null===(r=t.onProgress)||void 0===r||r.call(t,s/e.length)}n.close()}})}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(t,this.loadOptions)})}async getWeightUrls(e){const t=Array.isArray(this.path)?this.path[1]:this.path,[n,a]=function(e){const t=e.lastIndexOf("/"),n=e.lastIndexOf("?"),a=e.substring(0,t),i=n>t?e.substring(n):"";return[a+"/",i]}(t),i=this.weightPathPrefix||n,s=[],r=[];for(const t of e)for(const e of t.paths)null!=this.weightUrlConverter?r.push(this.weightUrlConverter(e)):s.push(i+e+a);return this.weightUrlConverter&&s.push(...await Promise.all(r)),s}async loadWeights(e){const t=await this.getWeightUrls(e),n=jn(e),a=await async function(e,t){null==t&&(t={});const n=null==t.fetchFunc?H().platform.fetch:t.fetchFunc,a=e.map((e=>n(e,t.requestInit,{isBinary:!0}))),i=(null==t.onProgress?await Promise.all(a):await ea(a,t.onProgress,0,.5)).map((e=>e.arrayBuffer()));return null==t.onProgress?await Promise.all(i):await ea(i,t.onProgress,.5,1)}(t,this.loadOptions);return[n,a]}}function na(e){return null!=e.match(ta.URL_SCHEME_REGEX)}ta.URL_SCHEME_REGEX=/^https?:\/\//;const aa=(e,t)=>{if("undefined"==typeof fetch&&(null==t||null==t.fetchFunc))return null;{let n=!0;if(n=Array.isArray(e)?e.every((e=>na(e))):na(e),n)return ia(e,t)}return null};function ia(e,t){return new ta(e,t)}zn.registerSaveRouter(aa),zn.registerLoadRouter(aa);class sa{constructor(){this.managers={}}static getInstance(){return null==sa.instance&&(sa.instance=new sa),sa.instance}static registerManager(e,t){x(null!=e,(()=>"scheme must not be undefined or null.")),e.endsWith("://")&&(e=e.slice(0,e.indexOf("://"))),x(e.length>0,(()=>"scheme must not be an empty string."));const n=sa.getInstance();x(null==n.managers[e],(()=>`A model store manager is already registered for scheme '${e}'.`)),n.managers[e]=t}static getManager(e){const t=sa.getInstance().managers[e];if(null==t)throw new Error(`Cannot find model manager for scheme '${e}'`);return t}static getSchemes(){return Object.keys(sa.getInstance().managers)}}
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ra=pn({cast_:function(e,t){const n=un(e,"x","cast");if(!function(e){return"bool"===e||"complex64"===e||"float32"===e||"int32"===e||"string"===e}(t))throw new Error(`Failed to cast to unknown dtype ${t}`);if("string"===t&&"string"!==n.dtype||"string"!==t&&"string"===n.dtype)throw new Error("Only strings can be casted to strings");const a={x:n},i={dtype:t};return an.runKernel(se,a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const oa=pn({matMul_:function(e,t,n=!1,a=!1){let i=un(e,"a","matMul"),s=un(t,"b","matMul");[i,s]=Zt(i,s);const r={a:i,b:s},o={transposeA:n,transposeB:a};return an.runKernel(ae,r,o)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const la=pn({oneHot_:function(e,t,n=1,a=0,i="int32"){if(t<2)throw new Error(`Error in oneHot: depth must be >=2, but it is ${t}`);const s={indices:un(e,"indices","oneHot","int32")},r={dtype:i,depth:t,onValue:n,offValue:a};return an.runKernel(De,s,r)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ca=pn({imag_:function(e){const t={input:un(e,"input","imag")};return an.runKernel("Imag",t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ua=pn({neg_:function(e){const t={x:un(e,"x","neg")};return an.runKernel("Neg",t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ha=pn({real_:function(e){const t={input:un(e,"input","real")};return an.runKernel("Real",t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const pa=pn({transpose_:function(e,t,n){const a=un(e,"x","transpose");if(null==t&&(t=a.shape.map(((e,t)=>t)).reverse()),x(a.rank===t.length,(()=>`Error in transpose: rank of input ${a.rank} must match length of perm ${t}.`)),t.forEach((e=>{x(e>=0&&e<a.rank,(()=>"All entries in 'perm' must be between 0 and "+(a.rank-1)+` but got ${t}`))})),a.rank<=1)return a.clone();const i={x:a},s={perm:t};return"complex64"===a.dtype?wn((()=>{let e=ha(a),t=ca(a);return e=an.runKernel(it,{x:e},s),t=an.runKernel(it,{x:t},s),n&&(t=ua(t)),dn(e,t)})):an.runKernel(it,i,s)}});
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function da(e,t){const n=e.length,a=[];for(let i=0;i<n;i++){const s=n-1-i,r=e[s]||1;(t[t.length-1-i]||1)>1&&1===r&&a.unshift(s)}return a}function fa(e,t){const n=[];for(let a=0;a<t.length;a++){const i=e[e.length-a-1],s=t.length-a-1,r=t[s];(null==i||1===i&&r>1)&&n.unshift(s)}return n}function ma(e,t){const n=Math.max(e.length,t.length),a=new Array(n);for(let i=0;i<n;i++){let s=e[e.length-i-1];null==s&&(s=1);let r=t[t.length-i-1];if(null==r&&(r=1),1===s)a[n-i-1]=r;else if(1===r)a[n-i-1]=s;else{if(s!==r){throw Error(`Operands could not be broadcast together with shapes ${e} and ${t}.`)}a[n-i-1]=s}}return a}
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function ga(e,t,n){let a;const i=e.shape.length;let s;return a="number"==typeof t?[t,...new Array(i-1).fill(0)]:t.length<i?t.concat(new Array(i-t.length).fill(0)):t.slice(),a.forEach((e=>{x(-1!==e,(()=>"slice() does not support negative begin indexing."))})),s=null==n?new Array(i).fill(-1):"number"==typeof n?[n,...new Array(i-1).fill(-1)]:n.length<i?n.concat(new Array(i-n.length).fill(-1)):n,s=s.map(((t,n)=>t>=0?t:(x(-1===t,(()=>`Negative size values should be exactly -1 but got ${t} for the slice() size at index ${n}.`)),e.shape[n]-a[n]))),[a,s]}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const va=new Map,ya=new Map;class ba{getClassName(){return this.constructor.className}static fromConfig(e,t){return new e(t)}}class wa{constructor(){this.classNameMap={}}static getMap(){return null==wa.instance&&(wa.instance=new wa),wa.instance}static register(e){wa.getMap().classNameMap[e.className]=[e,e.fromConfig]}}function ka(e,t,n){x(null!=e.className,(()=>"Class being registered does not have the static className property defined.")),x("string"==typeof e.className,(()=>"className is required to be a string, but got type "+typeof e.className)),x(e.className.length>0,(()=>"Class being registered has an empty-string as its className, which is disallowed.")),void 0===t&&(t="Custom"),void 0===n&&(n=e.className);const a=t+">"+n;return wa.register(e),va.set(a,e),ya.set(e,a),e}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const xa=pn({add_:function(e,t){let n=un(e,"a","add"),a=un(t,"b","add");[n,a]=Zt(n,a);const i={a:n,b:a};return an.runKernel(X,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Sa=pn({floorDiv_:function(e,t){let n=un(e,"a","floorDiv"),a=un(t,"b","floorDiv");[n,a]=Zt(n,a);const i={a:n,b:a};return an.runKernel(be,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Na=pn({div_:function(e,t){let n=un(e,"a","div"),a=un(t,"b","div");if([n,a]=Zt(n,a),"int32"===n.dtype&&"int32"===a.dtype)return Sa(n,a);const i={a:n,b:a};return an.runKernel(me,i,{})}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ta=pn({mul_:function(e,t){let n=un(e,"a","mul"),a=un(t,"b","mul");[n,a]=Zt(n,a);const i={a:n,b:a};return an.runKernel(je,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ia=pn({abs_:function(e){const t=un(e,"x","abs");if("complex64"===t.dtype){const e={x:t};return an.runKernel(oe,e)}{const e={x:t};return an.runKernel("Abs",e)}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ca=pn({all_:function(e,t=null,n=!1){const a={x:un(e,"x","all","bool")},i={axis:t,keepDims:n};return an.runKernel("All",a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const $a=pn({any_:function(e,t=null,n=!1){const a={x:un(e,"x","any","bool")},i={axis:t,keepDims:n};return an.runKernel("Any",a,i)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Aa=pn({argMax_:function(e,t=0){const n={x:un(e,"x","argMax")},a={axis:t};return an.runKernel(ee,n,a)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Ea(e,t,n,a,i,s,r=!1,o="channelsLast"){let[l,c,u,h]=[-1,-1,-1,-1];if("channelsLast"===o)[l,c,u,h]=e;else{if("channelsFirst"!==o)throw new Error(`Unknown dataFormat ${o}`);[l,h,c,u]=e}const[p,d,,f]=t,[m,g]=ja(n),[v,y]=ja(a),b=za(p,v),w=za(d,y),{padInfo:k,outHeight:x,outWidth:S}=function(e,t,n,a,i,s,r,o,l){let c,u,h;if("number"==typeof e){c={top:e,bottom:e,left:e,right:e,type:0===e?"VALID":"NUMBER"};const i=function(e,t,n,a,i){null==a&&(a=function(e,t,n,a=1){const i=za(t,a);return Math.floor((e[0]*(n-1)-n+i)/2)}(e,t,n));const s=e[0],r=e[1],o=Da((s-t+2*a)/n+1,i),l=Da((r-t+2*a)/n+1,i);return[o,l]}([t,n],s,a,e,o);u=i[0],h=i[1]}else if("same"===e){u=Math.ceil(t/a),h=Math.ceil(n/i);const e=Math.max(0,(u-1)*a+s-t),o=Math.max(0,(h-1)*i+r-n),l=Math.floor(e/2),p=e-l,d=Math.floor(o/2);c={top:l,bottom:p,left:d,right:o-d,type:"SAME"}}else if("valid"===e)c={top:0,bottom:0,left:0,right:0,type:"VALID"},u=Math.ceil((t-s+1)/a),h=Math.ceil((n-r+1)/i);else{if("object"!=typeof e)throw Error(`Unknown padding parameter: ${e}`);{const p="channelsLast"===l?e[1][0]:e[2][0],d="channelsLast"===l?e[1][1]:e[2][1],f="channelsLast"===l?e[2][0]:e[3][0],m="channelsLast"===l?e[2][1]:e[3][1];c={top:p,bottom:d,left:f,right:m,type:0===p&&0===d&&0===f&&0===m?"VALID":"EXPLICIT"},u=Da((t-s+p+d)/a+1,o),h=Da((n-r+f+m)/i+1,o)}}return{padInfo:c,outHeight:u,outWidth:h}}(i,c,u,m,g,b,w,s,o),N=r?f*h:f;let T;return"channelsFirst"===o?T=[l,N,x,S]:"channelsLast"===o&&(T=[l,x,S,N]),{batchSize:l,dataFormat:o,inHeight:c,inWidth:u,inChannels:h,outHeight:x,outWidth:S,outChannels:N,padInfo:k,strideHeight:m,strideWidth:g,filterHeight:p,filterWidth:d,effectiveFilterHeight:b,effectiveFilterWidth:w,dilationHeight:v,dilationWidth:y,inShape:e,outShape:T,filterShape:t}}function ja(e){return"number"==typeof e?[e,e,e]:2===e.length?[e[0],e[1],1]:e}function za(e,t){return t<=1?e:e+(e-1)*(t-1)}function Da(e,t){if(!t)return Math.trunc(e);switch(t){case"round":return Math.round(e);case"ceil":return Math.ceil(e);case"floor":return Math.floor(e);default:throw new Error(`Unknown roundingMode ${t}`)}}function Fa(e){const[t,n,a]=ja(e);return 1===t&&1===n&&1===a}function _a(e,t){return Fa(e)||Fa(t)}function Ra(e){return ja(e).every((e=>e>0))}function La(e,t,n){if(null!=n){if("string"==typeof t)throw Error(`Error in ${e}: pad must be an integer when using dimRoundingMode ${n} but got pad ${t}.`);if("number"==typeof t)x(I(t),(()=>`Error in ${e}: pad must be an integer when using dimRoundingMode ${n} but got pad ${t}.`));else{if("object"!=typeof t)throw Error(`Error in ${e}: Unknown padding parameter: ${t}`);t.forEach((t=>{t.forEach((t=>{x(I(t),(()=>`Error in ${e}: pad must be an integer when using dimRoundingMode ${n} but got pad ${t}.`))}))}))}}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ma=pn({reshape_:function(e,t){const n={x:un(e,"x","reshape","string_or_numeric")},a={shape:t};return an.runKernel(Me,n,a)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Oa=pn({avgPool_:function(e,t,n,a,i){const s=un(e,"x","avgPool","float32");x(_a(n,1),(()=>`Error in avgPool: Either strides or dilations must be 1. Got strides ${n} and dilations '1'`));let r=s,o=!1;3===s.rank&&(o=!0,r=Ma(s,[1,s.shape[0],s.shape[1],s.shape[2]])),x(4===r.rank,(()=>`Error in avgPool: x must be rank 4 but got rank ${r.rank}.`)),La("avgPool",a,i);const l={x:r},c={filterSize:t,strides:n,pad:a,dimRoundingMode:i};let u=an.runKernel(te,l,c);return u=ra(u,s.dtype),o?Ma(u,[u.shape[1],u.shape[2],u.shape[3]]):u}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Pa=pn({avgPool3d_:function(e,t,n,a,i,s="NDHWC"){const r=un(e,"x","avgPool3d","float32");let o=r,l=!1;4===r.rank&&(l=!0,o=Ma(r,[1,r.shape[0],r.shape[1],r.shape[2],r.shape[3]])),x(5===o.rank,(()=>`Error in avgPool3d: x must be rank 5 but got rank ${o.rank}.`)),x("NDHWC"===s,(()=>`Error in avgPool3d: Only NDHWC is currently supported, but got dataFormat of ${s}`)),x("number"==typeof n&&n>0||Array.isArray(n)&&n[0]>0&&n[1]>0&&n[2]>0,(()=>`Error in avgPool3d: Stride must be > 0, but got '${n}'`)),La("avgPool3d",a,i);const c={x:o},u={filterSize:t,strides:n,pad:a,dimRoundingMode:i,dataFormat:s};let h=an.runKernel(ne,c,u);return h=ra(h,o.dtype),l?Ma(h,[h.shape[1],h.shape[2],h.shape[3],h.shape[4]]):h}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ba=pn({clone_:function(e){const t={x:un(e,"x","clone","string_or_numeric")};return an.runKernel(Se,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ua=pn({concat_:function(e,t=0){x(e.length>=1,(()=>"Pass at least one tensor to concat"));const n=hn(e,"tensors","concat","string_or_numeric");if("complex64"===n[0].dtype&&n.forEach((e=>{if("complex64"!==e.dtype)throw new Error(`Cannot concatenate complex64 tensors with a tensor\n          with dtype ${e.dtype}. `)})),1===n.length)return Ba(n[0]);const a=n,i={axis:t};return an.runKernel(le,a,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Wa=pn({sigmoid_:function(e){const t={x:un(e,"x","sigmoid","float32")};return an.runKernel(Je,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ga=pn({slice_:function(e,t,n){const a=un(e,"x","slice","string_or_numeric");if(0===a.rank)throw new Error("Slicing scalar is not possible");const i={x:a},s={begin:t,size:n};return an.runKernel(qe,i,s)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Va=pn({tanh_:function(e){const t={x:un(e,"x","tanh","float32")};return an.runKernel(nt,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ka=pn({batchToSpaceND_:function(e,t,n){const a=un(e,"x","batchToSpaceND"),i=t.reduce(((e,t)=>e*t));x(a.rank>=1+t.length,(()=>`input rank is ${a.rank} but should be > than blockShape.length ${t.length}`)),x(n.length===t.length,(()=>`crops.length is ${n.length} but should be equal to blockShape.length  ${t.length}`)),x(a.shape[0]%i==0,(()=>`input tensor batch is ${a.shape[0]} but is not divisible by the product of the elements of blockShape ${t.join(" * ")} === ${i}`));const s={x:a},r={blockShape:t,crops:n};return an.runKernel(ie,s,r)}});const qa=pn({batchNorm_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i,s){null==s&&(s=.001);const r=un(e,"x","batchNorm"),o=un(t,"mean","batchNorm"),l=un(n,"variance","batchNorm");let c,u;null!=i&&(c=un(i,"scale","batchNorm")),null!=a&&(u=un(a,"offset","batchNorm")),x(o.rank===l.rank,(()=>"Batch normalization gradient requires mean and variance to have equal ranks.")),x(null==u||o.rank===u.rank,(()=>"Batch normalization gradient requires mean and offset to have equal ranks.")),x(null==c||o.rank===c.rank,(()=>"Batch normalization gradient requires mean and scale to have equal ranks."));const h={x:function(e){let t;return t=0===e.rank||1===e.rank?Ma(e,[1,1,1,e.size]):2===e.rank?Ma(e,[1,1,e.shape[0],e.shape[1]]):3===e.rank?Ma(e,[1,e.shape[0],e.shape[1],e.shape[2]]):e,t}(r),scale:c,offset:u,mean:o,variance:l},p={varianceEpsilon:s},d=an.runKernel(we,h,p);return Ma(d,r.shape)}});const Ha=pn({batchNorm2d_:function(e,t,n,a,i,s){const r=un(e,"x","batchNorm"),o=un(t,"mean","batchNorm"),l=un(n,"variance","batchNorm");let c,u;return null!=i&&(c=un(i,"scale","batchNorm")),null!=a&&(u=un(a,"offset","batchNorm")),x(2===r.rank,(()=>`Error in batchNorm2D: x must be rank 2 but got rank ${r.rank}.`)),x(2===o.rank||1===o.rank,(()=>`Error in batchNorm2D: mean must be rank 2 or rank 1 but got rank ${o.rank}.`)),x(2===l.rank||1===l.rank,(()=>`Error in batchNorm2D: variance must be rank 2 or rank 1 but got rank ${l.rank}.`)),null!=c&&x(2===c.rank||1===c.rank,(()=>`Error in batchNorm2D: scale must be rank 2 or rank 1 but got rank ${c.rank}.`)),null!=u&&x(2===u.rank||1===u.rank,(()=>`Error in batchNorm2D: offset must be rank 2 or rank 1 but got rank ${u.rank}.`)),qa(r,o,l,u,c,s)}});const Ja=pn({batchNorm3d_:function(e,t,n,a,i,s){const r=un(e,"x","batchNorm"),o=un(t,"mean","batchNorm"),l=un(n,"variance","batchNorm");let c,u;return null!=i&&(c=un(i,"scale","batchNorm")),null!=a&&(u=un(a,"offset","batchNorm")),x(3===r.rank,(()=>`Error in batchNorm3D: x must be rank 3 but got rank ${r.rank}.`)),x(3===o.rank||1===o.rank,(()=>`Error in batchNorm3D: mean must be rank 3 or rank 1 but got rank ${o.rank}.`)),x(3===l.rank||1===l.rank,(()=>`Error in batchNorm3D: variance must be rank 3 or rank 1 but got rank ${l.rank}.`)),null!=c&&x(3===c.rank||1===c.rank,(()=>`Error in batchNorm3D: scale must be rank 3 or rank 1 but got rank ${c.rank}.`)),null!=u&&x(3===u.rank||1===u.rank,(()=>`Error in batchNorm3D: offset must be rank 3 or rank 1 but got rank ${u.rank}.`)),qa(r,o,l,u,c,s)}});const Za=pn({batchNorm4d_:function(e,t,n,a,i,s){const r=un(e,"x","batchNorm"),o=un(t,"mean","batchNorm"),l=un(n,"variance","batchNorm");let c,u;return null!=i&&(c=un(i,"scale","batchNorm")),null!=a&&(u=un(a,"offset","batchNorm")),x(4===r.rank,(()=>`Error in batchNorm4D: x must be rank 4 but got rank ${r.rank}.`)),x(4===o.rank||1===o.rank,(()=>`Error in batchNorm4D: mean must be rank 4 or rank 1 but got rank ${o.rank}.`)),x(4===l.rank||1===l.rank,(()=>`Error in batchNorm4D: variance must be rank 4 or rank 1 but got rank ${l.rank}.`)),null!=c&&x(4===c.rank||1===c.rank,(()=>`Error in batchNorm4D: scale must be rank 4 or rank 1 but got rank ${c.rank}.`)),null!=u&&x(4===u.rank||1===u.rank,(()=>`Error in batchNorm4D: offset must be rank 4 or rank 1 but got rank ${u.rank}.`)),qa(r,o,l,u,c,s)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ya=pn({bincount_:function(e,t,n){const a=un(e,"x","bincount"),i=un(t,"weights","bincount");x("int32"===a.dtype,(()=>`Error in bincount: input dtype must be int32, but got ${a.dtype}`)),x(n>=0,(()=>`size must be non-negative, but got ${n}.`)),x(i.size===a.size||0===i.size,(()=>`Error in bincount: weights must have the same size as input or0-length, but got input shape: ${a.shape}, weights shape: ${i.shape}.`));const s={x:a,weights:i},r={size:n};return an.runKernel("Bincount",s,r)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Qa=pn({broadcastTo_:function(e,t){let n=un(e,"broadcastTo","x");const a=n.shape;if(B(t),t.length<n.rank)throw new Error(`broadcastTo(): shape.length=${t.length} < input.rank=${n.rank}.`);if(t.length>n.rank){const e=n.shape.slice();for(;e.length<t.length;)e.unshift(1);n=Ma(n,e)}const i=n.shape,s=Array.from(t);for(let e=t.length-1;e>=0;e--)if(i[e]===t[e])s[e]=1;else if(1!==n.shape[e])throw new Error(`broadcastTo(): [${a}] cannot be broadcast to [${t}].`);if(0===s.map(((e,t)=>e>1?t:-1)).filter((e=>e>=0)).length)return Ba(n);const r={x:n},o={reps:s};return an.runKernel(at,r,o)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Xa(e,t="float32",n){return t=t||"float32",B(e),new _t(e,t,n)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function ei(e,t,n){B(e);const a={shape:e,value:t,dtype:n=n||F(t)};return an.runKernel("Fill",{},a)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ti=pn({clipByValue_:function(e,t,n){const a=un(e,"x","clipByValue");if(x(t<=n,(()=>`Error in clip: min (${t}) must be less than or equal to max (${n}).`)),t===n)return ei(a.shape,t,a.dtype);const i={x:a},s={clipValueMin:t,clipValueMax:n};return an.runKernel(re,i,s)}});const ni=pn({concat1d_:function(e){return Ua(e,0)}});const ai=pn({concat2d_:function(e,t){return Ua(e,t)}});const ii=pn({concat3d_:function(e,t){return Ua(e,t)}});const si=pn({concat4d_:function(e,t){return Ua(e,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ri=pn({conv2d_:function(e,t,n,a,i="NHWC",s=[1,1],r){const o=un(e,"x","conv2d","float32"),l=un(t,"filter","conv2d","float32");let c=o,u=!1;3===o.rank&&(u=!0,c=Ma(o,[1,o.shape[0],o.shape[1],o.shape[2]])),x(4===c.rank,(()=>`Error in conv2d: input must be rank 4, but got rank ${c.rank}.`)),x(4===l.rank,(()=>`Error in conv2d: filter must be rank 4, but got rank ${l.rank}.`)),La("conv2d",a,r);const h="NHWC"===i?c.shape[3]:c.shape[1];x(h===l.shape[2],(()=>`Error in conv2d: depth of input (${h}) must match input depth for filter ${l.shape[2]}.`)),x(_a(n,s),(()=>`Error in conv2D: Either strides or dilations must be 1. Got strides ${n} and dilations '${s}'`)),x(Ra(s),(()=>"Error in conv2D: Dilated rates should be larger than 0.")),x(Ra(n),(()=>"Error in conv2D: Strides should be larger than 0."));const p={x:c,filter:l},d={strides:n,pad:a,dataFormat:i,dilations:s,dimRoundingMode:r},f=an.runKernel(ce,p,d);return u?Ma(f,[f.shape[1],f.shape[2],f.shape[3]]):f}});const oi=pn({conv1d_:function(e,t,n,a,i="NWC",s=1,r){const o=un(e,"x","conv1d"),l=un(t,"filter","conv1d");let c=o,u=!1;2===o.rank&&(u=!0,c=Ma(o,[1,o.shape[0],o.shape[1]])),x(3===c.rank,(()=>`Error in conv1d: input must be rank 3, but got rank ${c.rank}.`)),x(3===l.rank,(()=>`Error in conv1d: filter must be rank 3, but got rank ${l.rank}.`)),La("conv1d",a,r),x(c.shape[2]===l.shape[1],(()=>`Error in conv1d: depth of input (${c.shape[2]}) must match input depth for filter ${l.shape[1]}.`)),x(_a(n,s),(()=>`Error in conv1D: Either stride or dilation must be 1. Got stride ${n} and dilation '${s}'`)),x(Ra(s),(()=>"Error in conv1D: Dilated rates should be larger than 0.")),x(Ra(n),(()=>"Error in conv1D: Stride should be larger than 0.")),x("NWC"===i,(()=>`Error in conv1d: got dataFormat of ${i} but only NWC is currently supported.`));const h=Ma(l,[1,l.shape[0],l.shape[1],l.shape[2]]),p=Ma(c,[c.shape[0],1,c.shape[1],c.shape[2]]),d=ri(p,h,[1,n],a,"NHWC",[1,s],r);return Ma(d,u?[d.shape[2],d.shape[3]]:[d.shape[0],d.shape[2],d.shape[3]])}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const li=pn({conv2DBackpropInput_:function(e,t,n,a,i,s="NHWC",r){x(e.length===t.rank,(()=>`Length of inShape (${e.length}) and rank of dy (${t.rank}) must match`));let o=e,l=t,c=!1;3===t.rank&&(c=!0,l=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2]]),o=[1,e[0],e[1],e[2]]),x(4===o.length,(()=>`Error in conv2dDerInput: inShape must be length 4, but got length ${o.length}.`)),x(4===l.rank,(()=>`Error in conv2dDerInput: dy must be rank 4, but got rank ${l.rank}`)),x(4===n.rank,(()=>`Error in conv2dDerInput: filter must be rank 4, but got rank ${n.rank}`));const u="NHWC"===s?o[3]:o[1],h="NHWC"===s?l.shape[3]:l.shape[1];x(u===n.shape[2],(()=>`Error in conv2dDerInput: depth of input (${u}) must match input depth for filter ${n.shape[2]}.`)),x(h===n.shape[3],(()=>`Error in conv2dDerInput: depth of output (${h}) must match output depth for filter ${n.shape[3]}.`)),La("conv2dDerInput",i,r);const p={dy:l,filter:n},d={strides:a,pad:i,dataFormat:s,dimRoundingMode:r,inputShape:o},f=an.runKernel(ue,p,d);return c?Ma(f,[f.shape[1],f.shape[2],f.shape[3]]):f}});const ci=pn({conv2dTranspose_:function(e,t,n,a,i,s){const r=un(e,"x","conv2dTranspose"),o=un(t,"filter","conv2dTranspose");return li(n,r,o,a,i,"NHWC",s)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ui=pn({conv3d_:function(e,t,n,a,i="NDHWC",s=[1,1,1]){const r=un(e,"x","conv3d"),o=un(t,"filter","conv3d");let l=r,c=!1;4===r.rank&&(c=!0,l=Ma(r,[1,r.shape[0],r.shape[1],r.shape[2],r.shape[3]])),x(5===l.rank,(()=>`Error in conv3d: input must be rank 5, but got rank ${l.rank}.`)),x(5===o.rank,(()=>`Error in conv3d: filter must be rank 5, but got rank ${o.rank}.`)),x(l.shape[4]===o.shape[3],(()=>`Error in conv3d: depth of input (${l.shape[4]}) must match input depth for filter ${o.shape[3]}.`)),x(_a(n,s),(()=>`Error in conv3D: Either strides or dilations must be 1. Got strides ${n} and dilations '${s}'`)),x("NDHWC"===i,(()=>`Error in conv3d: got dataFormat of ${i} but only NDHWC is currently supported.`)),x(Ra(s),(()=>"Error in conv3D: Dilated rates should be larger than 0.")),x(Ra(n),(()=>"Error in conv3D: Strides should be larger than 0."));const u={x:l,filter:o},h={strides:n,pad:a,dataFormat:i,dilations:s},p=an.runKernel(he,u,h);return c?Ma(p,[p.shape[1],p.shape[2],p.shape[3],p.shape[4]]):p}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const hi=pn({conv3DBackpropInput_:function(e,t,n,a,i){x(e.length===t.rank,(()=>`Length of inShape (${e.length}) and rank of dy (${t.rank}) must match`));let s=e,r=t,o=!1;4===t.rank&&(o=!0,r=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2],t.shape[3]]),s=[1,e[0],e[1],e[2],e[3]]);const l=s[4],c=r.shape[4];x(5===s.length,(()=>`Error in conv3dDerInput: inShape must be length 5, but got length ${s.length}.`)),x(5===r.rank,(()=>`Error in conv3dDerInput: dy must be rank 5, but got rank ${r.rank}`)),x(5===n.rank,(()=>`Error in conv3dDerInput: filter must be rank 5, but got rank ${n.rank}`)),x(l===n.shape[3],(()=>`Error in conv3dDerInput: depth of input (${l}) must match input depth for filter ${n.shape[3]}.`)),x(c===n.shape[4],(()=>`Error in conv3dDerInput: depth of output (${c}) must match output depth for filter ${n.shape[4]}.`));const u={dy:r,filter:n},h={pad:i,strides:a,inputShape:s},p=an.runKernel("Conv3DBackpropInputV2",u,h);return o?Ma(p,[p.shape[1],p.shape[2],p.shape[3],p.shape[4]]):p}});const pi=pn({conv3dTranspose_:function(e,t,n,a,i){const s=un(e,"x","conv3dTranspose"),r=un(t,"filter","conv3dTranspose");return hi(n,s,r,a,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const di=pn({cos_:function(e){const t={x:un(e,"x","cos","float32")};return an.runKernel("Cos",t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const fi=pn({cosh_:function(e){const t={x:un(e,"x","cosh","float32")};return an.runKernel(pe,t)}});
/**
     * @license
     * Copyright 2022 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the 'License');
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an 'AS IS' BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const mi=pn({cumprod_:function(e,t=0,n=!1,a=!1){const i={x:un(e,"x","cumprod")},s={axis:t,exclusive:n,reverse:a};return an.runKernel("Cumprod",i,s)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const gi=pn({cumsum_:function(e,t=0,n=!1,a=!1){const i={x:un(e,"x","cumsum")},s={axis:t,exclusive:n,reverse:a};return an.runKernel(de,i,s)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const vi=pn({denseBincount_:function(e,t,n,a=!1){const i=un(e,"x","denseBincount"),s=un(t,"weights","denseBincount");x("int32"===i.dtype,(()=>`Error in denseBincount: input dtype must be int32, but got ${i.dtype}`)),x(i.rank<=2,(()=>`Error in denseBincount: input must be at most rank 2, but got rank ${i.rank}.`)),x(n>=0,(()=>`size must be non-negative, but got ${n}.`)),x(s.size===i.size||0===s.size,(()=>`Error in denseBincount: weights must have the same shape as x or 0-length, but got x shape: ${i.shape}, weights shape: ${s.shape}.`));const r={x:i,weights:s},o={size:n,binaryOutput:a};return an.runKernel("DenseBincount",r,o)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const yi=pn({depthwiseConv2d_:function(e,t,n,a,i="NHWC",s=[1,1],r){const o=un(e,"x","depthwiseConv2d","float32"),l=un(t,"filter","depthwiseConv2d","float32");let c=o,u=!1;3===o.rank&&(u=!0,c=Ma(o,[1,o.shape[0],o.shape[1],o.shape[2]])),x(4===c.rank,(()=>`Error in depthwiseConv2d: input must be rank 4, but got rank ${c.rank}.`)),x(4===l.rank,(()=>`Error in depthwiseConv2d: filter must be rank 4, but got rank ${l.rank}.`));const h="NHWC"===i?c.shape[3]:c.shape[1];x(h===l.shape[2],(()=>`Error in depthwiseConv2d: number of input channels (${h}) must match the inChannels dimension in filter ${l.shape[2]}.`)),La("depthwiseConv2d",a,r);const p={x:c,filter:l},d={strides:n,pad:a,dataFormat:i,dilations:s,dimRoundingMode:r},f=an.runKernel(fe,p,d);return u?Ma(f,[f.shape[1],f.shape[2],f.shape[3]]):f}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const bi=pn({equal_:function(e,t){let n=un(e,"a","equal","string_or_numeric"),a=un(t,"b","equal","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("Equal",i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const wi=pn({where_:function(e,t,n){const a=un(t,"a","where"),i=un(n,"b","where"),s=un(e,"condition","where","bool"),r=ma(ma(s.shape,a.shape),i.shape),o={condition:Qa(s,r),t:Qa(a,r),e:Qa(i,r)};return an.runKernel(Ve,o)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ki=pn({zerosLike_:function(e){const t={x:un(e,"x","zerosLike")};return an.runKernel(ot,t)}});
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const xi=pn({einsum_:function(e,...t){const n=t.map(((e,t)=>un(e,`tensors${t}`,"einsum"))),a={equation:e};return an.runKernel("Einsum",n,a)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Si=pn({elu_:function(e){const t={x:un(e,"x","elu","float32")};return an.runKernel(ge,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ni=pn({erf_:function(e){let t=un(e,"x","erf");x("int32"===t.dtype||"float32"===t.dtype,(()=>"Input dtype must be `int32` or `float32`.")),"int32"===t.dtype&&(t=ra(t,"float32"));const n={x:t};return an.runKernel("Erf",n)}});
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Ti(e,t){for(let n=0;n<e.length;++n)if(e[e.length-n-1]!==t-1-n)return!1;return!0}function Ii(e,t){const n=[],a=e.length;for(let i=0;i<a;i++)-1===t.indexOf(i)&&n.push(e[i]);return[n,t.map((t=>e[t]))]}function Ci(e,t){return function(e,t,n){const a=e.length+t.length,i=[];let s=0,r=0;for(let o=0;o<a;o++)-1===n.indexOf(o)?i.push(e[s++]):i.push(t[r++]);return i}(e,t.map((e=>1)),t)}function $i(e,t){if(Ti(e,t))return null;const n=[];for(let a=0;a<t;++a)-1===e.indexOf(a)&&n.push(a);return e.forEach((e=>n.push(e))),n}function Ai(e){return e.map(((e,t)=>[t,e])).sort(((e,t)=>e[1]-t[1])).map((e=>e[0]))}const Ei=pn({max_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t=null,n=!1){const a={x:un(e,"x","max")},i={reductionIndices:t,keepDims:n};return an.runKernel("Max",a,i)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ji=pn({min_:function(e,t=null,n=!1){const a={x:un(e,"x","min")},i={axis:t,keepDims:n};return an.runKernel("Min",a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const zi=pn({pow_:function(e,t){let n=un(e,"base","pow"),a=un(t,"exp","pow");[n,a]=Zt(n,a);const i={a:n,b:a};return an.runKernel("Pow",i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Di(e,t){if((Tt(e)&&"string"!==t||Array.isArray(e))&&"complex64"!==t)throw new Error("Error creating a new Scalar: value must be a primitive (number|boolean|string)");if("string"===t&&Tt(e)&&!(e instanceof Uint8Array))throw new Error("When making a scalar from encoded string, the value must be `Uint8Array`.");return fn(e,[],[],t)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Fi=pn({sqrt_:function(e){const t={x:un(e,"x","sqrt","float32")};return an.runKernel(Ye,t)}});
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const _i=pn({square_:function(e){const t=un(e,"x","square");return an.runKernel("Square",{x:t},{})}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ri=pn({sum_:function(e,t=null,n=!1){let a=un(e,"x","sum");"bool"===a.dtype&&(a=ra(a,"int32"));const i={x:a},s={axis:t,keepDims:n};return an.runKernel(Qe,i,s)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Li(e,t,n=null){if(0===e.rank)return Ia(e);if(1!==e.rank&&null===n)return Li(Ma(e,[-1]),t,n);if(1===e.rank||"number"==typeof n||Array.isArray(n)&&1===n.length){if(1===t)return Ri(Ia(e),n);if(t===1/0)return Ei(Ia(e),n);if(t===-1/0)return ji(Ia(e),n);if("euclidean"===t||2===t)return Fi(Ri(zi(Ia(e),Di(2,"int32")),n));throw new Error(`Error in norm: invalid ord value: ${t}`)}if(Array.isArray(n)&&2===n.length){if(1===t)return Ei(Ri(Ia(e),n[0]),n[1]-1);if(t===1/0)return Ei(Ri(Ia(e),n[1]),n[0]);if(t===-1/0)return ji(Ri(Ia(e),n[1]),n[0]);if("fro"===t||"euclidean"===t)return Fi(Ri(_i(e),n));throw new Error(`Error in norm: invalid ord value: ${t}`)}throw new Error(`Error in norm: invalid axis: ${n}`)}const Mi=pn({norm_:function(e,t="euclidean",n=null,a=!1){const i=Li(e=un(e,"x","norm"),t,n);let s=i.shape;if(a){const t=$(n,e.shape);s=Ci(i.shape,t)}return Ma(i,s)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Oi=pn({exp_:function(e){const t={x:un(e,"x","exp")};return an.runKernel("Exp",t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Pi=pn({expandDims_:function(e,t=0){const n=un(e,"x","expandDims","string_or_numeric");x(t<=n.rank,(()=>"Axis must be <= rank of the tensor"));const a={input:n},i={dim:t};return an.runKernel(ve,a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Bi=pn({tile_:function(e,t){const n=un(e,"x","tile","string_or_numeric");x(n.rank===t.length,(()=>`Error in transpose: rank of input ${n.rank} must match length of reps ${t}.`));const a={x:n},i={reps:t};return an.runKernel(at,a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ui=pn({eye_:function(e,t,n,a="float32"){null==t&&(t=e);const i=Xa([e,t],a),s=e<=t?e:t;for(let e=0;e<s;++e)i.set(1,e,e);const r=Ma(i.toTensor(),[e,t]);if(null==n)return r;if(1===n.length)return Bi(Pi(r,0),[n[0],1,1]);if(2===n.length)return Bi(Pi(Pi(r,0),0),[n[0],n[1],1,1]);if(3===n.length)return Bi(Pi(Pi(Pi(r,0),0),0),[n[0],n[1],n[2],1,1]);throw new Error(`eye() currently supports only 1D and 2D batchShapes, but received ${n.length}D.`)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Wi=pn({floor_:function(e){const t={x:un(e,"x","floor","float32")};return an.runKernel(ye,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Gi=pn({gather_:function(e,t,n=0,a=0){const i={x:un(e,"x","gather"),indices:un(t,"indices","gather","int32")},s={axis:n,batchDims:a};return an.runKernel(ke,i,s)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Vi=pn({greater_:function(e,t){let n=un(e,"a","greater","string_or_numeric"),a=un(t,"b","greater","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("Greater",i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ki=pn({greaterEqual_:function(e,t){let n=un(e,"a","greaterEqual","string_or_numeric"),a=un(t,"b","greaterEqual","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel(xe,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const qi=pn({leakyRelu_:function(e,t=.2){const n={x:un(e,"x","leakyRelu")},a={alpha:t};return an.runKernel(Ne,n,a)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Hi=pn({less_:function(e,t){let n=un(e,"a","less","string_or_numeric"),a=un(t,"b","less","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("Less",i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ji=pn({lessEqual_:function(e,t){let n=un(e,"a","lessEqual","string_or_numeric"),a=un(t,"b","lessEqual","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("LessEqual",i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Zi=pn({log_:function(e){const t={x:un(e,"x","log","float32")};return an.runKernel("Log",t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Yi=pn({log1p_:function(e){const t={x:un(e,"x","log1p")};return an.runKernel(Te,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Qi(e){return an.customGrad(e)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Xi=pn({softplus_:function(e){const t={x:un(e,"x","softplus")};return an.runKernel(Ze,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const es=pn({sub_:function(e,t){let n=un(e,"a","sub"),a=un(t,"b","sub");[n,a]=Zt(n,a);const i={a:n,b:a};return an.runKernel("Sub",i)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ts=pn({logSoftmax_:function(e,t=-1){const n=un(e,"logits","logSoftmax");if(-1===t&&(t=n.rank-1),t!==n.rank-1)throw Error(`Log Softmax along a non-last dimension is not yet supported. Logits was rank ${n.rank} and axis was ${t}`);const a=Qi(((e,n)=>{const a=Ei(e,t,!0),i=es(e,a),s=es(ra(i,"float32"),Zi(Ri(Oi(i),t,!0)));n([s]);return{value:s,gradFunc:(e,n)=>{const[a]=n,i=Oi(a);return es(e,Ta(Ri(e,t,!0),i))}}}));return a(n)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ns=pn({logSumExp_:function(e,t=null,n=!1){const a=un(e,"x","logSumExp"),i=$(t,a.shape),s=Ei(a,i,!0),r=es(a,s),o=Oi(r),l=Ri(o,i),c=Zi(l),u=xa(Ma(s,c.shape),c);if(n){const e=Ci(u.shape,i);return Ma(u,e)}return u}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const as=pn({logicalAnd_:function(e,t){const n=un(e,"a","logicalAnd","bool"),a=un(t,"b","logicalAnd","bool");ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("LogicalAnd",i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const is=pn({logicalNot_:function(e){const t={x:un(e,"x","logicalNot","bool")};return an.runKernel("LogicalNot",t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ss=pn({maxPool_:function(e,t,n,a,i){const s=un(e,"x","maxPool");let r=s,o=!1;3===s.rank&&(o=!0,r=Ma(s,[1,s.shape[0],s.shape[1],s.shape[2]])),x(4===r.rank,(()=>`Error in maxPool: input must be rank 4 but got rank ${r.rank}.`)),x(_a(n,1),(()=>`Error in maxPool: Either strides or dilations must be 1. Got strides ${n} and dilations '1'`)),La("maxPool",a,i);const l={x:r},c={filterSize:t,strides:n,pad:a,dimRoundingMode:i},u=an.runKernel(Ce,l,c);return o?Ma(u,[u.shape[1],u.shape[2],u.shape[3]]):u}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const rs=pn({maxPool3d_:function(e,t=[1,1,1],n,a,i,s="NDHWC"){const r=un(e,"x","maxPool3d");let o=r,l=!1;4===r.rank&&(l=!0,o=Ma(r,[1,r.shape[0],r.shape[1],r.shape[2],r.shape[3]])),x(5===o.rank,(()=>`Error in maxPool3d: x must be rank 5 but got rank ${o.rank}.`)),x("NDHWC"===s,(()=>`Error in maxPool3d: Only NDHWC is currently supported, but got dataFormat of ${s}`)),La("maxPool3d",a,i);const c={x:o},u={filterSize:t,strides:n,pad:a,dimRoundingMode:i,dataFormat:s},h=an.runKernel($e,c,u);return l?Ma(h,[h.shape[1],h.shape[2],h.shape[3],h.shape[4]]):h}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const os=pn({maximum_:function(e,t){let n=un(e,"a","maximum"),a=un(t,"b","maximum");[n,a]=Zt(n,a),"bool"===n.dtype&&(n=ra(n,"int32"),a=ra(a,"int32")),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel(Ie,i)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ls=pn({mean_:function(e,t=null,n=!1){const a={x:un(e,"x","mean")},i={axis:t,keepDims:n};return an.runKernel(Ae,a,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function cs(e,t="float32"){if(B(e),"complex64"===t){const t=cs(e,"float32"),n=cs(e,"float32");return dn(t,n)}const n=P(N(e),t);return an.makeTensor(n,e,t)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function us(e,t="float32"){if(B(e),"complex64"===t){const t=us(e,"float32"),n=cs(e,"float32");return dn(t,n)}const n=O(N(e),t);return an.makeTensor(n,e,t)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const hs=pn({minimum_:function(e,t){let n=un(e,"a","minimum"),a=un(t,"b","minimum");[n,a]=Zt(n,a),"bool"===n.dtype&&(n=ra(n,"int32"),a=ra(a,"int32")),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel(Ee,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ps=pn({moments_:function(e,t=null,n=!1){const a=$(t,(e=un(e,"x","moments")).shape),i=ls(e,a,n);let s=i.shape;n||(s=Ci(i.shape,a));const r=_i(es(ra(e,"float32"),Ma(i,s)));return{mean:i,variance:ls(r,a,n)}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ds=pn({notEqual_:function(e,t){let n=un(e,"a","notEqual","string_or_numeric"),a=un(t,"b","notEqual","string_or_numeric");[n,a]=Zt(n,a),ma(n.shape,a.shape);const i={a:n,b:a};return an.runKernel("NotEqual",i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const fs=pn({onesLike_:function(e){const t={x:un(e,"x","onesLike")};return an.runKernel(ze,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ms=pn({pad_:function(e,t,n=0){const a=un(e,"x","pad");if(0===a.rank)throw new Error("pad(scalar) is not defined. Pass non-scalar to pad");const i={paddings:t,constantValue:n},s={x:a};return an.runKernel(_e,s,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const gs=pn({spaceToBatchND_:function(e,t,n){const a=un(e,"x","spaceToBatchND");x(a.rank>=1+t.length,(()=>`input rank ${a.rank} should be > than [blockShape] ${t.length}`)),x(n.length===t.length,(()=>`paddings.shape[0] ${n.length} must be equal to [blockShape] ${t.length}`)),x(a.shape.reduce(((e,a,i)=>i>0&&i<=t.length?e&&(a+n[i-1][0]+n[i-1][1])%t[i-1]==0:e),!0),(()=>`input spatial dimensions ${a.shape.slice(1)} with paddings ${n.toString()} must be divisible by blockShapes ${t.toString()}`));const i={x:a},s={blockShape:t,paddings:n};return an.runKernel(Xe,i,s)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const vs=pn({prelu_:function(e,t){const n={x:un(e,"x","prelu"),alpha:un(t,"alpha","prelu")};return an.runKernel(Re,n)}});
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */var ys,bs={exports:{}};function ws(){return ys||(ys=1,function(e){!function(e,t){function n(e){var t=this,n=function(){var e=4022871197,t=function(t){t=String(t);for(var n=0;n<t.length;n++){var a=.02519603282416938*(e+=t.charCodeAt(n));a-=e=a>>>0,e=(a*=e)>>>0,e+=4294967296*(a-=e)}return 2.3283064365386963e-10*(e>>>0)};return t}();t.next=function(){var e=2091639*t.s0+2.3283064365386963e-10*t.c;return t.s0=t.s1,t.s1=t.s2,t.s2=e-(t.c=0|e)},t.c=1,t.s0=n(" "),t.s1=n(" "),t.s2=n(" "),t.s0-=n(e),t.s0<0&&(t.s0+=1),t.s1-=n(e),t.s1<0&&(t.s1+=1),t.s2-=n(e),t.s2<0&&(t.s2+=1),n=null}function a(e,t){return t.c=e.c,t.s0=e.s0,t.s1=e.s1,t.s2=e.s2,t}function i(e,t){var i=new n(e),s=t&&t.state,r=i.next;return r.int32=function(){return 4294967296*i.next()|0},r.double=function(){return r()+11102230246251565e-32*(2097152*r()|0)},r.quick=r,s&&("object"==typeof s&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.alea=i}(0,e)}(bs)),bs.exports}var ks,xs={exports:{}};function Ss(){return ks||(ks=1,function(e){!function(e,t){function n(e){var t=this,n="";t.x=0,t.y=0,t.z=0,t.w=0,t.next=function(){var e=t.x^t.x<<11;return t.x=t.y,t.y=t.z,t.z=t.w,t.w^=t.w>>>19^e^e>>>8},e===(0|e)?t.x=e:n+=e;for(var a=0;a<n.length+64;a++)t.x^=0|n.charCodeAt(a),t.next()}function a(e,t){return t.x=e.x,t.y=e.y,t.z=e.z,t.w=e.w,t}function i(e,t){var i=new n(e),s=t&&t.state,r=function(){return(i.next()>>>0)/4294967296};return r.double=function(){do{var e=((i.next()>>>11)+(i.next()>>>0)/4294967296)/(1<<21)}while(0===e);return e},r.int32=i.next,r.quick=r,s&&("object"==typeof s&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.xor128=i}(0,e)}(xs)),xs.exports}var Ns,Ts={exports:{}};function Is(){return Ns||(Ns=1,function(e){!function(e,t){function n(e){var t=this,n="";t.next=function(){var e=t.x^t.x>>>2;return t.x=t.y,t.y=t.z,t.z=t.w,t.w=t.v,(t.d=t.d+362437|0)+(t.v=t.v^t.v<<4^e^e<<1)|0},t.x=0,t.y=0,t.z=0,t.w=0,t.v=0,e===(0|e)?t.x=e:n+=e;for(var a=0;a<n.length+64;a++)t.x^=0|n.charCodeAt(a),a==n.length&&(t.d=t.x<<10^t.x>>>4),t.next()}function a(e,t){return t.x=e.x,t.y=e.y,t.z=e.z,t.w=e.w,t.v=e.v,t.d=e.d,t}function i(e,t){var i=new n(e),s=t&&t.state,r=function(){return(i.next()>>>0)/4294967296};return r.double=function(){do{var e=((i.next()>>>11)+(i.next()>>>0)/4294967296)/(1<<21)}while(0===e);return e},r.int32=i.next,r.quick=r,s&&("object"==typeof s&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.xorwow=i}(0,e)}(Ts)),Ts.exports}var Cs,$s={exports:{}};function As(){return Cs||(Cs=1,function(e){!function(e,t){function n(e){var t=this;t.next=function(){var e,n,a=t.x,i=t.i;return e=a[i],n=(e^=e>>>7)^e<<24,n^=(e=a[i+1&7])^e>>>10,n^=(e=a[i+3&7])^e>>>3,n^=(e=a[i+4&7])^e<<7,e=a[i+7&7],n^=(e^=e<<13)^e<<9,a[i]=n,t.i=i+1&7,n},function(e,t){var n,a=[];if(t===(0|t))a[0]=t;else for(t=""+t,n=0;n<t.length;++n)a[7&n]=a[7&n]<<15^t.charCodeAt(n)+a[n+1&7]<<13;for(;a.length<8;)a.push(0);for(n=0;n<8&&0===a[n];++n);for(8==n?a[7]=-1:a[n],e.x=a,e.i=0,n=256;n>0;--n)e.next()}(t,e)}function a(e,t){return t.x=e.x.slice(),t.i=e.i,t}function i(e,t){null==e&&(e=+new Date);var i=new n(e),s=t&&t.state,r=function(){return(i.next()>>>0)/4294967296};return r.double=function(){do{var e=((i.next()>>>11)+(i.next()>>>0)/4294967296)/(1<<21)}while(0===e);return e},r.int32=i.next,r.quick=r,s&&(s.x&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.xorshift7=i}(0,e)}($s)),$s.exports}var Es,js={exports:{}};function zs(){return Es||(Es=1,function(e){!function(e,t){function n(e){var t=this;t.next=function(){var e,n,a=t.w,i=t.X,s=t.i;return t.w=a=a+1640531527|0,n=i[s+34&127],e=i[s=s+1&127],n^=n<<13,e^=e<<17,n^=n>>>15,e^=e>>>12,n=i[s]=n^e,t.i=s,n+(a^a>>>16)|0},function(e,t){var n,a,i,s,r,o=[],l=128;for(t===(0|t)?(a=t,t=null):(t+="\0",a=0,l=Math.max(l,t.length)),i=0,s=-32;s<l;++s)t&&(a^=t.charCodeAt((s+32)%t.length)),0===s&&(r=a),a^=a<<10,a^=a>>>15,a^=a<<4,a^=a>>>13,s>=0&&(r=r+1640531527|0,i=0==(n=o[127&s]^=a+r)?i+1:0);for(i>=128&&(o[127&(t&&t.length||0)]=-1),i=127,s=512;s>0;--s)a=o[i+34&127],n=o[i=i+1&127],a^=a<<13,n^=n<<17,a^=a>>>15,n^=n>>>12,o[i]=a^n;e.w=r,e.X=o,e.i=i}(t,e)}function a(e,t){return t.i=e.i,t.w=e.w,t.X=e.X.slice(),t}function i(e,t){null==e&&(e=+new Date);var i=new n(e),s=t&&t.state,r=function(){return(i.next()>>>0)/4294967296};return r.double=function(){do{var e=((i.next()>>>11)+(i.next()>>>0)/4294967296)/(1<<21)}while(0===e);return e},r.int32=i.next,r.quick=r,s&&(s.X&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.xor4096=i}(0,e)}(js)),js.exports}var Ds,Fs={exports:{}};function _s(){return Ds||(Ds=1,function(e){!function(e,t){function n(e){var t=this,n="";t.next=function(){var e=t.b,n=t.c,a=t.d,i=t.a;return e=e<<25^e>>>7^n,n=n-a|0,a=a<<24^a>>>8^i,i=i-e|0,t.b=e=e<<20^e>>>12^n,t.c=n=n-a|0,t.d=a<<16^n>>>16^i,t.a=i-e|0},t.a=0,t.b=0,t.c=-1640531527,t.d=1367130551,e===Math.floor(e)?(t.a=e/4294967296|0,t.b=0|e):n+=e;for(var a=0;a<n.length+20;a++)t.b^=0|n.charCodeAt(a),t.next()}function a(e,t){return t.a=e.a,t.b=e.b,t.c=e.c,t.d=e.d,t}function i(e,t){var i=new n(e),s=t&&t.state,r=function(){return(i.next()>>>0)/4294967296};return r.double=function(){do{var e=((i.next()>>>11)+(i.next()>>>0)/4294967296)/(1<<21)}while(0===e);return e},r.int32=i.next,r.quick=r,s&&("object"==typeof s&&a(s,i),r.state=function(){return a(i,{})}),r}t&&t.exports?t.exports=i:this.tychei=i}(0,e)}(Fs)),Fs.exports}var Rs,Ls,Ms,Os={exports:{}},Ps=Os.exports;function Bs(){return Rs||(Rs=1,function(e){!function(t,n,a){var i,s=256,r="random",o=a.pow(s,6),l=a.pow(2,52),c=2*l,u=255;function h(e,u,h){var v=[],y=m(f((u=1==u?{entropy:!0}:u||{}).entropy?[e,g(n)]:null==e?function(){try{var e;return i&&(e=i.randomBytes)?e=e(s):(e=new Uint8Array(s),(t.crypto||t.msCrypto).getRandomValues(e)),g(e)}catch(e){var a=t.navigator,r=a&&a.plugins;return[+new Date,t,r,t.screen,g(n)]}}():e,3),v),b=new p(v),w=function(){for(var e=b.g(6),t=o,n=0;e<l;)e=(e+n)*s,t*=s,n=b.g(1);for(;e>=c;)e/=2,t/=2,n>>>=1;return(e+n)/t};return w.int32=function(){return 0|b.g(4)},w.quick=function(){return b.g(4)/4294967296},w.double=w,m(g(b.S),n),(u.pass||h||function(e,t,n,i){return i&&(i.S&&d(i,b),e.state=function(){return d(b,{})}),n?(a[r]=e,t):e})(w,y,"global"in u?u.global:this==a,u.state)}function p(e){var t,n=e.length,a=this,i=0,r=a.i=a.j=0,o=a.S=[];for(n||(e=[n++]);i<s;)o[i]=i++;for(i=0;i<s;i++)o[i]=o[r=u&r+e[i%n]+(t=o[i])],o[r]=t;(a.g=function(e){for(var t,n=0,i=a.i,r=a.j,o=a.S;e--;)t=o[i=u&i+1],n=n*s+o[u&(o[i]=o[r=u&r+t])+(o[r]=t)];return a.i=i,a.j=r,n})(s)}function d(e,t){return t.i=e.i,t.j=e.j,t.S=e.S.slice(),t}function f(e,t){var n,a=[],i=typeof e;if(t&&"object"==i)for(n in e)try{a.push(f(e[n],t-1))}catch(e){}return a.length?a:"string"==i?e:e+"\0"}function m(e,t){for(var n,a=e+"",i=0;i<a.length;)t[u&i]=u&(n^=19*t[u&i])+a.charCodeAt(i++);return g(t)}function g(e){return String.fromCharCode.apply(0,e)}if(m(a.random(),n),e.exports){e.exports=h;try{i=require("crypto")}catch(e){}}else a["seed"+r]=h}("undefined"!=typeof self?self:Ps,[],Math)}(Os)),Os.exports}var Us=function(){if(Ms)return Ls;Ms=1;var e=ws(),t=Ss(),n=Is(),a=As(),i=zs(),s=_s(),r=Bs();return r.alea=e,r.xor128=t,r.xorwow=n,r.xorshift7=a,r.xor4096=i,r.tychei=s,Ls=r}();
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class Ws{constructor(e,t,n,a,i){this.mean=e,this.stdDev=t,this.dtype=n,this.nextVal=NaN,this.truncated=a,this.truncated&&(this.upper=this.mean+2*this.stdDev,this.lower=this.mean-2*this.stdDev);const s=i||Math.random();this.random=Us.alea(s.toString())}nextValue(){if(!isNaN(this.nextVal)){const e=this.nextVal;return this.nextVal=NaN,e}let e,t,n=!1;for(;!n;){let a,i,s;do{a=2*this.random()-1,i=2*this.random()-1,s=a*a+i*i}while(s>=1||0===s);const r=Math.sqrt(-2*Math.log(s)/s);e=this.mean+this.stdDev*a*r,t=this.mean+this.stdDev*i*r,this.truncated&&!this.isValidTruncated(e)||(n=!0)}return this.truncated&&!this.isValidTruncated(t)||(this.nextVal=this.convertValue(t)),this.convertValue(e)}convertValue(e){return null==this.dtype||"float32"===this.dtype?e:Math.round(e)}isValidTruncated(e){return e<=this.upper&&e>=this.lower}}class Gs{constructor(e=0,t=1,n,a){if(this.canReturnFloat=()=>null==this.dtype||"float32"===this.dtype,this.min=e,this.range=t-e,this.dtype=n,null==a&&(a=Math.random()),"number"==typeof a&&(a=a.toString()),!this.canReturnFloat()&&this.range<=1)throw new Error(`The difference between ${e} - ${t} <= 1 and dtype is not float`);this.random=Us.alea(a)}convertValue(e){return this.canReturnFloat()?e:Math.round(e)}nextValue(){return this.convertValue(this.min+this.range*this.random())}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Vs=pn({randomNormal_:function(e,t=0,n=1,a,i){if(B(e),null!=a&&"bool"===a)throw new Error(`Unsupported data type ${a}`);const s=new Ws(t,n,a,!1,i),r=Xa(e,a);for(let e=0;e<r.values.length;e++)r.values[e]=s.nextValue();return r.toTensor()}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ks=pn({randomUniform_:function(e,t=0,n=1,a="float32",i){B(e);const s=Xa(e,a),r=new Gs(t,n,null,i);for(let e=0;e<s.values.length;e++)s.values[e]=r.nextValue();return s.toTensor()}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function qs(e,t,n=1,a="float32"){if(0===n)throw new Error("Cannot have a step of zero");const i={start:e,stop:t,step:n,dtype:a};return an.runKernel("Range",{},i)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Hs=pn({relu_:function(e){const t={x:un(e,"x","relu")};return an.runKernel(Le,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Js=pn({relu6_:function(e){const t={x:un(e,"x","relu6")};return an.runKernel(Be,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Zs=pn({reverse_:function(e,t){const n={x:un(e,"x","reverse")},a={dims:t};return an.runKernel(Ue,n,a)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ys=pn({round_:function(e){const t={x:un(e,"x","round")};return an.runKernel(We,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Qs=pn({rsqrt_:function(e){const t={x:un(e,"x","rsqrt","float32")};return an.runKernel(Ge,t)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Xs=pn({selu_:function(e){const t={x:un(e,"x","selu")};return an.runKernel(Ke,t)}});const er=pn({separableConv2d_:function(e,t,n,a,i,s=[1,1],r="NHWC"){const o=un(e,"x","separableConv2d"),l=un(t,"depthwiseFilter","separableConv2d"),c=un(n,"pointwiseFilter","separableConv2d");let u=o,h=!1;if(3===o.rank&&(h=!0,u=Ma(o,[1,o.shape[0],o.shape[1],o.shape[2]])),"NCHW"===r)throw new Error("separableConv2d currently does not support dataFormat NCHW; only NHWC is supported");x(4===u.rank,(()=>`Error in separableConv2d: input must be rank 4, but got rank ${u.rank}.`)),x(4===l.rank,(()=>`Error in separableConv2d: depthwise filter must be rank 4, but got rank ${l.rank}.`)),x(4===c.rank,(()=>`Error in separableConv2d: pointwise filter must be rank 4, but got rank ${l.rank}.`)),x(1===c.shape[0],(()=>`Error in separableConv2d: the first dimension of pointwise filter  must be 1, but got ${c.shape[0]}.`)),x(1===c.shape[1],(()=>`Error in separableConv2d: the second dimension of pointwise filter must be 1, but got ${c.shape[1]}.`));const p=l.shape[2],d=l.shape[3];x(c.shape[2]===p*d,(()=>`Error in separableConv2d: the third dimension of pointwise filter must be ${p*d}, but got ${c.shape[2]}.`));const f=yi(u,l,a,i,r,s),m=ri(f,c,1,"valid",r);return h?Ma(m,[m.shape[1],m.shape[2],m.shape[3]]):m}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const tr=pn({sin_:function(e){const t={x:un(e,"x","sin","float32")};return an.runKernel("Sin",t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const nr=pn({sinh_:function(e){const t={x:un(e,"x","sinh")};return an.runKernel(He,t)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ar=pn({slice1d_:function(e,t,n){const a=un(e,"x","slice1d");return x(1===a.rank,(()=>`slice1d expects a rank-1 tensor, but got a rank-${a.rank} tensor`)),Ga(a,[t],[n])}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ir=pn({slice2d_:function(e,t,n){const a=un(e,"x","slice2d");return x(2===a.rank,(()=>`slice2d expects a rank-2 tensor, but got a rank-${a.rank} tensor`)),Ga(a,t,n)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const sr=pn({slice3d_:function(e,t,n){const a=un(e,"x","slice3d");return x(3===a.rank,(()=>`slice3d expects a rank-3 tensor, but got a rank-${a.rank} tensor`)),Ga(a,t,n)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const rr=pn({slice4d_:function(e,t,n){const a=un(e,"x","slice4d");return x(4===a.rank,(()=>`slice4d expects a rank-4 tensor, but got a rank-${a.rank} tensor`)),Ga(a,t,n)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const or=pn({softmax_:function(e,t=-1){const n=un(e,"logits","softmax","float32");if(-1===t&&(t=n.rank-1),t!==n.rank-1)throw Error(`Softmax along a non-last dimension is not yet supported. Logits was rank ${n.rank} and dim was ${t}`);const a={logits:n},i={dim:t};return an.runKernel(tt,a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const lr=pn({split_:function(e,t,n=0){const a={x:un(e,"x","split")},i={numOrSizeSplits:t,axis:n};return an.runKernel(et,a,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const cr=pn({squeeze_:function(e,t){const n=un(e,"x","squeeze","string_or_numeric");return Ma(n,function(e,t){const n=[],a=[],i=null!=t&&Array.isArray(t)&&0===t.length,s=null==t||i?null:$(t,e).sort();let r=0;for(let t=0;t<e.length;++t){if(null!=s){if(s[r]===t&&1!==e[t])throw new Error(`Can't squeeze axis ${t} since its dim '${e[t]}' is not 1`);(null==s[r]||s[r]>t)&&1===e[t]&&(n.push(e[t]),a.push(t)),s[r]<=t&&r++}1!==e[t]&&(n.push(e[t]),a.push(t))}return{newShape:n,keptDims:a}}(n.shape,t).newShape)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ur=pn({stack_:function(e,t=0){const n=hn(e,"tensors","stack","string_or_numeric");x(n.length>=1,(()=>"Pass at least one tensor to tf.stack")),n.length>0&&x(t<=n[0].rank,(()=>"Axis must be <= rank of the tensor"));const a=n,i={axis:t};return an.runKernel(Fe,a,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const hr=pn({step_:function(e,t=0){const n={x:un(e,"x","step")},a={alpha:t};return an.runKernel(lt,n,a)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function pr(e,t){S(e);const n=on(e,t);if(1!==n.length)throw new Error("tensor1d() requires values to be a flat/TypedArray");return fn(e,null,n,t)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function dr(e,t,n){if(S(e),null!=t&&2!==t.length)throw new Error("tensor2d() requires shape to have two numbers");const a=on(e,n);if(2!==a.length&&1!==a.length)throw new Error("tensor2d() requires values to be number[][] or flat/TypedArray");if(1===a.length&&null==t)throw new Error("tensor2d() requires shape to be provided when `values` are a flat/TypedArray");return fn(e,t,a,n)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const fr=pn({truncatedNormal_:function(e,t=0,n=1,a,i){if(B(e),null!=a&&"bool"===a)throw new Error("Unsupported data type $ { dtype }");const s=new Ws(t,n,a,!0,i),r=Xa(e,a);for(let e=0;e<r.values.length;e++)r.values[e]=s.nextValue();return r.toTensor()}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const mr=pn({unsortedSegmentSum_:function(e,t,n){const a=un(e,"x","unsortedSegmentSum"),i=un(t,"segmentIds","unsortedSegmentSum","int32");x(I(n),(()=>"numSegments must be of dtype int"));const s={x:a,segmentIds:i},r={numSegments:n};return an.runKernel(rt,s,r)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const gr=pn({unstack_:function(e,t=0){const n=un(e,"x","unstack","string_or_numeric");x(t>=-n.shape.length&&t<n.shape.length,(()=>`Axis = ${t} is not in [-${n.shape.length}, ${n.shape.length})`));const a={value:n},i={axis:t};return an.runKernel(st,a,i)}});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const vr=pn({dropout_:
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a){const i=un(e,"x","dropout");if(x("float32"===i.dtype,(()=>`x has to be a floating point tensor since it's going to be scaled, but got a ${i.dtype} tensor instead.`)),x(t>=0&&t<1,(()=>`rate must be a float in the range [0, 1), but got ${t}.`)),0===t)return e instanceof Mt?i.clone():i;const s=
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t){if(null==t)return e.shape.slice();if(T(e.shape,t))return t;if(e.shape.length===t.length){const n=[];for(let a=0;a<e.shape.length;a++)null==t[a]&&null!=e.shape[a]?n.push(e.shape[a]):n.push(t[a]);return n}return t}(i,n),r=1-t,o=Na(Wi(xa(Ks(s,0,1,"float32",a),r)),r);return Ta(i,o)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const yr=pn({conv2DBackpropFilter_:function(e,t,n,a,i,s="NHWC",r){let o=e;3===e.rank&&(o=Ma(e,[1,e.shape[0],e.shape[1],e.shape[2]]));let l=t;3===l.rank&&(l=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2]])),x(4===o.rank,(()=>`Error in conv2dDerFilter: input must be rank 4, but got shape ${o.shape}.`)),x(4===l.rank,(()=>`Error in conv2dDerFilter: dy must be rank 4, but got shape ${l.shape}.`)),x(4===n.length,(()=>`Error in conv2dDerFilter: filterShape must be length 4, but got ${n}.`));const c="NHWC"===s?o.shape[3]:o.shape[1],u="NHWC"===s?l.shape[3]:l.shape[1];x(c===n[2],(()=>`Error in conv2dDerFilter: depth of input ${c}) must match input depth in filter (${n[2]}.`)),x(u===n[3],(()=>`Error in conv2dDerFilter: depth of dy (${u}) must match output depth for filter (${n[3]}).`)),La("conv2dDerFilter",i,r);const h={x:o,dy:l},p={strides:a,pad:i,dataFormat:s,dimRoundingMode:r,filterShape:n};return an.runKernel("Conv2DBackpropFilter",h,p)}});
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function br(e,t,n){if(null==n||"linear"===n)return e;if("relu"===n)return Ta(e,hr(t));throw new Error(`Cannot compute gradient for fused activation ${n}.`)}function wr(e,t){let n=t;const a=fa(e.shape,t.shape);return a.length>0&&(n=Ri(n,a)),Ma(n,e.shape)}function kr(e,t,n,a){if("linear"===t)return e;if("relu"===t)return Hs(e);if("elu"===t)return Si(e);if("relu6"===t)return Js(e);if("prelu"===t)return vs(e,n);if("leakyrelu"===t)return qi(e,a);if("sigmoid"===t)return Wa(e);throw new Error(`Unknown fused activation ${t}.`)}const xr=(e,t)=>!(e>0)||"linear"===t;
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Sr=pn({fusedConv2d_:function({x:e,filter:t,strides:n,pad:a,dataFormat:i="NHWC",dilations:s=[1,1],dimRoundingMode:r,bias:o,activation:l="linear",preluActivationWeights:c,leakyreluAlpha:u}){if(l=l||"linear",!1===xr(an.state.gradientDepth,l)){x("NHWC"===i,(()=>`Error in fused conv2d: got dataFormat of ${i} but only NHWC is currently supported for the case of gradient depth is 0 and the activation is not linear.`));let h=ri(e,t,n,a,i,s,r);return null!=o&&(h=xa(h,o)),kr(h,l,c,u)}const h=un(e,"x","conv2d","float32"),p=un(t,"filter","conv2d","float32");let d=h,f=!1;3===h.rank&&(f=!0,d=Ma(h,[1,h.shape[0],h.shape[1],h.shape[2]])),x(4===d.rank,(()=>`Error in fused conv2d: input must be rank 4, but got rank ${d.rank}.`)),x(4===p.rank,(()=>`Error in fused conv2d: filter must be rank 4, but got rank ${p.rank}.`)),La("fused conv2d",a,r);const m="NHWC"===i?d.shape[3]:d.shape[1];x(p.shape[2]===m,(()=>`Error in conv2d: depth of input (${m}) must match input depth for filter ${p.shape[2]}.`)),x(_a(n,s),(()=>`Error in conv2D: Either strides or dilations must be 1. Got strides ${n} and dilations '${s}'`));const g=Ea(d.shape,p.shape,n,s,a,r);let v,y;if(null!=o&&(v=un(o,"bias","fused conv2d"),[v]=Zt(v,h),"NHWC"===i?ma(g.outShape,v.shape):(x(v.shape.length<=1,(()=>`Error in fused conv2d: only supports scalar or 1-D Tensor bias for NCHW format but got the bias of rank-${v.shape.length}.`)),x(0===v.shape.length||v.shape[0]===g.outChannels||1===v.shape[0],(()=>`Error in fused conv2d: bias shape (${v.shape}) is not compatible with the number of output channels (${g.outChannels})`)))),null!=c){const e=c.shape;if(x(e.length<=1||3===e.length,(()=>`Error in fused conv2d: only supports scalar, 1-D Tensor or 3-D Tensor PReLU activation weights but got a tensor of rank-${e.length}.`)),1===e.length)x(1===e[0]||e[0]===g.outChannels,(()=>`Error in fused conv2d: PReLU activation weights (${e}) is not compatible with the number of output channels (${g.outChannels}).`));else if(3===e.length)try{ma(e,g.outShape)}catch(t){const n=`Error in fused conv2d: PReLU activation weights (${e}) is not compatible with the output shape of the conv2d (${g.outShape}).`;throw Error(n)}y=un(c,"prelu weights","fused conv2d")}const b=(e,t)=>{x("NHWC"===i,(()=>`Error in gradient of fused conv2D: got dataFormat of ${i} but only NHWC is currently supported.`));const[r,o,c,u]=t,h=br(e,c,l);x(Fa(s),(()=>`Error in gradient of fused conv2D: dilation rates greater than 1 are not yet supported in gradients. Got dilations '${s}'`));const p=[li(o.shape,h,r,n,a),yr(o,h,r.shape,n,a)];if(null!=u){const e=wr(u,h);p.push(e)}return p},w={x:d,filter:p,bias:v,preluActivationWeights:y},k={strides:n,pad:a,dataFormat:i,dilations:s,dimRoundingMode:r,activation:l,leakyreluAlpha:u};if(null==o){const e=Qi(((e,t,n)=>{let a=an.runKernel(ut,w,k);return n([t,e,a]),f&&(a=Ma(a,[a.shape[1],a.shape[2],a.shape[3]])),{value:a,gradFunc:b}}));return e(d,p)}{const e=Qi(((e,t,n,a)=>{let i=an.runKernel(ut,w,k);return a([t,e,i,n]),f&&(i=Ma(i,[i.shape[1],i.shape[2],i.shape[3]])),{value:i,gradFunc:b}}));return e(d,p,v)}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Nr=pn({depthwiseConv2dNativeBackpropFilter_:function(e,t,n,a,i,s=[1,1],r){let o=e;3===e.rank&&(o=Ma(e,[1,e.shape[0],e.shape[1],e.shape[2]]));let l=t;3===l.rank&&(l=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2]]));const c={x:o,dy:l},u={strides:a,pad:i,dimRoundingMode:r,dilations:s,filterShape:n};return an.runKernel("DepthwiseConv2dNativeBackpropFilter",c,u)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Tr=pn({depthwiseConv2dNativeBackpropInput_:function(e,t,n,a,i,s=[1,1],r){let o=t,l=!1;3===t.rank&&(l=!0,o=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2]]));const c={dy:o,filter:n},u={strides:a,pad:i,dimRoundingMode:r,dilations:s,inputShape:e},h=an.runKernel("DepthwiseConv2dNativeBackpropInput",c,u);return l?Ma(h,[h.shape[1],h.shape[2],h.shape[3]]):h}});
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ir=pn({fusedMatMul_:function({a:e,b:t,transposeA:n=!1,transposeB:a=!1,bias:i,activation:s="linear",preluActivationWeights:r,leakyreluAlpha:o=.2}){if(!1===xr(an.state.gradientDepth,s)){let l=oa(e,t,n,a);return null!=i&&(l=xa(l,i)),kr(l,s,r,o)}let l=un(e,"a","fused matMul"),c=un(t,"b","fused matMul");[l,c]=Zt(l,c);const u=n?l.shape[l.rank-2]:l.shape[l.rank-1],h=a?c.shape[c.rank-1]:c.shape[c.rank-2],p=n?l.shape[l.rank-1]:l.shape[l.rank-2],d=a?c.shape[c.rank-2]:c.shape[c.rank-1],f=l.shape.slice(0,-2),m=c.shape.slice(0,-2),g=N(f),v=N(m);x(u===h,(()=>`Error in fused matMul: inner shapes (${u}) and (${h}) of Tensors with shapes ${l.shape} and ${c.shape} and transposeA=${n} and transposeB=${a} must match.`));const y=ma(l.shape.slice(0,-2),c.shape.slice(0,-2)).concat([p,d]),b=Ma(l,n?[g,u,p]:[g,p,u]),w=Ma(c,a?[v,d,h]:[v,h,d]);let k,S;null!=i&&(k=un(i,"bias","fused matMul"),[k]=Zt(k,l),ma(y,k.shape)),null!=r&&(S=un(r,"prelu weights","fused matMul"));const T=(e,t)=>{const[r,o,l,c]=t,u=br(Ma(e,l.shape),l,s);let h,p;if(n||a?!n&&a?(h=oa(u,o,!1,!1),p=oa(u,r,!0,!1)):n&&!a?(h=oa(o,u,!1,!0),p=oa(r,u,!1,!1)):(h=oa(o,u,!0,!0),p=oa(u,r,!0,!0)):(h=oa(u,o,!1,!0),p=oa(r,u,!0,!1)),null!=i){return[h,p,wr(c,u)]}return[h,p]},I={a:b,b:w,bias:k,preluActivationWeights:S},C={transposeA:n,transposeB:a,activation:s,leakyreluAlpha:o};if(null==i){const e=Qi(((e,t,n)=>{const a=an.runKernel(ct,I,C);return n([e,t,a]),{value:Ma(a,y),gradFunc:T}}));return e(b,w)}{const e=Qi(((e,t,n,a)=>{const i=an.runKernel(ct,I,C);return a([e,t,i,n]),{value:Ma(i,y),gradFunc:T}}));return e(b,w,k)}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Cr=pn({cropAndResize_:function(e,t,n,a,i="bilinear",s=0){const r=un(e,"image","cropAndResize"),o=un(t,"boxes","cropAndResize","float32"),l=un(n,"boxInd","cropAndResize","int32"),c=o.shape[0];x(4===r.rank,(()=>`Error in cropAndResize: image must be rank 4,but got rank ${r.rank}.`)),x(2===o.rank&&4===o.shape[1],(()=>`Error in cropAndResize: boxes must be have size [${c},4] but had shape ${o.shape}.`)),x(1===l.rank&&l.shape[0]===c,(()=>`Error in cropAndResize: boxInd must be have size [${c}] but had shape ${o.shape}.`)),x(2===a.length,(()=>`Error in cropAndResize: cropSize must be of length 2, but got length ${a.length}.`)),x(a[0]>=1&&a[1]>=1,(()=>`cropSize must be atleast [1,1], but was ${a}`)),x("bilinear"===i||"nearest"===i,(()=>`method must be bilinear or nearest, but was ${i}`));const u={image:r,boxes:o,boxInd:l},h={method:i,extrapolationValue:s,cropSize:a};return an.runKernel("CropAndResize",u,h)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const $r=pn({flipLeftRight_:function(e){const t=un(e,"image","flipLeftRight","float32");x(4===t.rank,(()=>`Error in flipLeftRight: image must be rank 4,but got rank ${t.rank}.`));const n={image:t};return an.runKernel("FlipLeftRight",n,{})}});
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ar=pn({grayscaleToRGB_:function(e){const t=un(e,"image","grayscaleToRGB"),n=t.rank-1,a=t.shape[n];x(t.rank>=2,(()=>`Error in grayscaleToRGB: images must be at least rank 2, but got rank ${t.rank}.`)),x(1===a,(()=>`Error in grayscaleToRGB: last dimension of a grayscale image should be size 1, but got size ${a}.`));const i=new Array(t.rank);return i.fill(1,0,n),i[n]=3,Bi(t,i)}});
/**
     * @license
     * Copyright 2023 Google LLC.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Er=pn({rgbToGrayscale_:function(e){const t=un(e,"image","RGBToGrayscale"),n=t.rank-1,a=t.shape[n];x(t.rank>=2,(()=>`Error in RGBToGrayscale: images must be at least rank 2, but got rank ${t.rank}.`)),x(3===a,(()=>`Error in RGBToGrayscale: last dimension of an RGB image should be size 3, but got size ${a}.`));const i=t.dtype,s=ra(t,"float32"),r=pr([.2989,.587,.114]);let o;switch(t.rank){case 2:o=xi("ij,j->i",s,r);break;case 3:o=xi("ijk,k->ij",s,r);break;case 4:o=xi("ijkl,l->ijk",s,r);break;case 5:o=xi("ijklm,m->ijkl",s,r);break;case 6:o=xi("ijklmn,n->ijklm",s,r);break;default:throw new Error("Not a valid tensor rank.")}return o=Pi(o,-1),ra(o,i)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const jr=pn({rotateWithOffset_:function(e,t,n=0,a=.5){const i=un(e,"image","rotateWithOffset","float32");x(4===i.rank,(()=>`Error in rotateWithOffset: image must be rank 4,but got rank ${i.rank}.`));const s={image:i},r={radians:t,fillValue:n,center:a};return an.runKernel("RotateWithOffset",s,r)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function zr(e,t,n,a,i,s){null==a&&(a=.5),null==i&&(i=Number.NEGATIVE_INFINITY),null==s&&(s=0);const r=e.shape[0];return n=Math.min(n,r),x(0<=a&&a<=1,(()=>`iouThreshold must be in [0, 1], but was '${a}'`)),x(2===e.rank,(()=>`boxes must be a 2D tensor, but was of rank '${e.rank}'`)),x(4===e.shape[1],(()=>`boxes must have 4 columns, but 2nd dimension was ${e.shape[1]}`)),x(1===t.rank,(()=>"scores must be a 1D tensor")),x(t.shape[0]===r,(()=>`scores has incompatible shape with boxes. Expected ${r}, but was ${t.shape[0]}`)),x(0<=s&&s<=1,(()=>`softNmsSigma must be in [0, 1], but was '${s}'`)),{maxOutputSize:n,iouThreshold:a,scoreThreshold:i,softNmsSigma:s}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Dr=pn({nonMaxSuppression_:function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY){const s=un(e,"boxes","nonMaxSuppression","float32"),r=un(t,"scores","nonMaxSuppression","float32"),o=zr(s,r,n,a,i),l={maxOutputSize:n=o.maxOutputSize,iouThreshold:a=o.iouThreshold,scoreThreshold:i=o.scoreThreshold};return an.runKernel("NonMaxSuppressionV3",{boxes:s,scores:r},l)}});
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Fr(e,t,n){const a=function(e,t,n){return function(e,t,n){let a=0,i=e.length,s=0,r=!1;for(;a<i;){s=a+(i-a>>>1);const o=n(t,e[s]);o>0?a=s+1:(i=s,r=!o)}return r?a:-a-1}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(e,t,n||_r)}(e,t,n),i=a<0?-(a+1):a;e.splice(i,0,t)}function _r(e,t){return e>t?1:e<t?-1:0}function Rr(e,t,n,a,i,s,r=!1,o=!1,l=!1){const c=[];for(let e=0;e<t.length;e++)t[e]>i&&c.push({score:t[e],boxIndex:e,suppressBeginIndex:0});c.sort(Or);const u=s>0?-.5/s:0,h=[],p=[];for(;h.length<n&&c.length>0;){const t=c.pop(),{score:n,boxIndex:s,suppressBeginIndex:r}=t;if(n<i)break;let o=!1;for(let n=h.length-1;n>=r;--n){const r=Lr(e,s,h[n]);if(r>=a){o=!0;break}if(t.score=t.score*Mr(a,u,r),t.score<=i)break}t.suppressBeginIndex=h.length,o||(t.score===n?(h.push(s),p.push(t.score)):t.score>i&&Fr(c,t,Or))}const d=h.length,f=n-d;o&&f>0&&(h.push(...new Array(f).fill(0)),p.push(...new Array(f).fill(0)));const m={selectedIndices:h};return r&&(m.selectedScores=p),l&&(m.validOutputs=d),m}function Lr(e,t,n){const a=e.subarray(4*t,4*t+4),i=e.subarray(4*n,4*n+4),s=Math.min(a[0],a[2]),r=Math.min(a[1],a[3]),o=Math.max(a[0],a[2]),l=Math.max(a[1],a[3]),c=Math.min(i[0],i[2]),u=Math.min(i[1],i[3]),h=Math.max(i[0],i[2]),p=Math.max(i[1],i[3]),d=(o-s)*(l-r),f=(h-c)*(p-u);if(d<=0||f<=0)return 0;const m=Math.max(s,c),g=Math.max(r,u),v=Math.min(o,h),y=Math.min(l,p),b=Math.max(v-m,0)*Math.max(y-g,0);return b/(d+f-b)}function Mr(e,t,n){const a=Math.exp(t*n*n);return n<=e?a:0}function Or(e,t){return e.score-t.score||e.score===t.score&&t.boxIndex-e.boxIndex}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Pr=async function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY){const s=un(e,"boxes","nonMaxSuppressionAsync"),r=un(t,"scores","nonMaxSuppressionAsync"),o=zr(s,r,n,a,i);n=o.maxOutputSize,a=o.iouThreshold,i=o.scoreThreshold;const l=await Promise.all([s.data(),r.data()]),c=l[0],u=l[1],{selectedIndices:h}=function(e,t,n,a,i){return Rr(e,t,n,a,i,0)}(c,u,n,a,i);return s!==e&&s.dispose(),r!==t&&r.dispose(),pr(h,"int32")};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Br=pn({nonMaxSuppressionWithScore_:function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY,s=0){const r=un(e,"boxes","nonMaxSuppression"),o=un(t,"scores","nonMaxSuppression"),l=zr(r,o,n,a,i,s),c={boxes:r,scores:o},u={maxOutputSize:n=l.maxOutputSize,iouThreshold:a=l.iouThreshold,scoreThreshold:i=l.scoreThreshold,softNmsSigma:s=l.softNmsSigma},h=an.runKernel("NonMaxSuppressionV5",c,u);return{selectedIndices:h[0],selectedScores:h[1]}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ur=async function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY,s=0){const r=un(e,"boxes","nonMaxSuppressionAsync"),o=un(t,"scores","nonMaxSuppressionAsync"),l=zr(r,o,n,a,i,s);n=l.maxOutputSize,a=l.iouThreshold,i=l.scoreThreshold,s=l.softNmsSigma;const c=await Promise.all([r.data(),o.data()]),u=c[0],h=c[1],{selectedIndices:p,selectedScores:d}=function(e,t,n,a,i,s){return Rr(e,t,n,a,i,s,!0)}(u,h,n,a,i,s);return r!==e&&r.dispose(),o!==t&&o.dispose(),{selectedIndices:pr(p,"int32"),selectedScores:pr(d)}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Wr=pn({nonMaxSuppressionPadded_:function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY,s=!1){const r=un(e,"boxes","nonMaxSuppression"),o=un(t,"scores","nonMaxSuppression"),l=zr(r,o,n,a,i,null),c={boxes:r,scores:o},u={maxOutputSize:l.maxOutputSize,iouThreshold:l.iouThreshold,scoreThreshold:l.scoreThreshold,padToMaxOutputSize:s},h=an.runKernel("NonMaxSuppressionV4",c,u);return{selectedIndices:h[0],validOutputs:h[1]}}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Gr=async function(e,t,n,a=.5,i=Number.NEGATIVE_INFINITY,s=!1){const r=un(e,"boxes","nonMaxSuppressionAsync"),o=un(t,"scores","nonMaxSuppressionAsync"),l=zr(r,o,n,a,i,null),c=l.maxOutputSize,u=l.iouThreshold,h=l.scoreThreshold,[p,d]=await Promise.all([r.data(),o.data()]),{selectedIndices:f,validOutputs:m}=function(e,t,n,a,i,s){return Rr(e,t,n,a,i,0,!1,s,!0)}(p,d,c,u,h,s);return r!==e&&r.dispose(),o!==t&&o.dispose(),{selectedIndices:pr(f,"int32"),validOutputs:Di(m,"int32")}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Vr=pn({resizeBilinear_:function(e,t,n=!1,a=!1){const i=un(e,"images","resizeBilinear");x(3===i.rank||4===i.rank,(()=>`Error in resizeBilinear: x must be rank 3 or 4, but got rank ${i.rank}.`)),x(2===t.length,(()=>`Error in resizeBilinear: new shape must 2D, but got shape ${t}.`)),x(!1===a||!1===n,(()=>"Error in resizeBilinear: If halfPixelCenters is true, alignCorners must be false."));let s=i,r=!1;3===i.rank&&(r=!0,s=Ma(i,[1,i.shape[0],i.shape[1],i.shape[2]]));const o={images:s},l={alignCorners:n,halfPixelCenters:a,size:t},c=an.runKernel(Pe,o,l);return r?Ma(c,[c.shape[1],c.shape[2],c.shape[3]]):c}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Kr=pn({resizeNearestNeighbor_:function(e,t,n=!1,a=!1){const i=un(e,"images","resizeNearestNeighbor");x(3===i.rank||4===i.rank,(()=>`Error in resizeNearestNeighbor: x must be rank 3 or 4, but got rank ${i.rank}.`)),x(2===t.length,(()=>`Error in resizeNearestNeighbor: new shape must 2D, but got shape ${t}.`)),x("float32"===i.dtype||"int32"===i.dtype,(()=>"`images` must have `int32` or `float32` as dtype")),x(!1===a||!1===n,(()=>"Error in resizeNearestNeighbor: If halfPixelCenters is true, alignCorners must be false."));let s=i,r=!1;3===i.rank&&(r=!0,s=Ma(i,[1,i.shape[0],i.shape[1],i.shape[2]]));const o={images:s},l={alignCorners:n,halfPixelCenters:a,size:t},c=an.runKernel(Oe,o,l);return r?Ma(c,[c.shape[1],c.shape[2],c.shape[3]]):c}});
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * https://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const qr=pn({threshold_:function(e,t="binary",n=!1,a=.5){const i=un(e,"image","threshold"),s=i.shape[0]*i.shape[1];let r,o,l,c,u=Ta(pr([a]),255);if(x(3===i.rank,(()=>`Error in threshold: image must be rank 3,but got rank ${i.rank}.`)),x(3===i.shape[2]||1===i.shape[2],(()=>`Error in threshold: image color channel must be equal to 3 or 1but got ${i.shape[2]}.`)),x("int32"===i.dtype||"float32"===i.dtype,(()=>`Error in dtype: image dtype must be int32 or float32,but got dtype ${i.dtype}.`)),x("otsu"===t||"binary"===t,(()=>`Method must be binary or otsu, but was ${t}`)),3===i.shape[2]){[r,o,l]=lr(i,[1,1,1],-1);const e=Ta(r,.2989),t=Ta(o,.587),n=Ta(l,.114);c=xa(xa(e,t),n)}else c=e;if("otsu"===t){u=function(e,t){let n,a,i,s,r,o,l=pr([-1]),c=pr([0]),u=pr([0]);for(let h=0;h<e.size-1;h++){n=Ga(e,0,h+1),a=Ga(e,h+1),r=Na(Ri(n),t),o=Na(Ri(a),t);const p=Ri(Ta(n,qs(0,n.size)));i=Na(p,Ri(n));const d=ei(a.shape,n.size),f=xa(qs(0,a.size),d),m=Ta(a,f);s=Na(Ri(m),Ri(a));const g=es(i,s),v=es(i,s),y=Ta(r,o);u=Ta(Ta(y,g),v);const b=Vi(u,c);c=wi(b,u,c),l=wi(b,pr([h]),l)}return l}(Ya(ra(Ys(c),"int32"),mn([]),256),s)}const h=n?Ji(c,u):Vi(c,u);return ra(Ta(h,255),"int32")}});
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Hr=pn({transform_:function(e,t,n="nearest",a="constant",i=0,s){const r=un(e,"image","transform","float32"),o=un(t,"transforms","transform","float32");x(4===r.rank,(()=>`Error in transform: image must be rank 4,but got rank ${r.rank}.`)),x(2===o.rank&&(o.shape[0]===r.shape[0]||1===o.shape[0])&&8===o.shape[1],(()=>"Error in transform: Input transform should be batch x 8 or 1 x 8")),x(null==s||2===s.length,(()=>`Error in transform: outputShape must be [height, width] or null, but got ${s}.`));const l={image:r,transforms:o},c={interpolation:n,fillMode:a,fillValue:i,outputShape:s};return an.runKernel("Transform",l,c)}});
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Jr(e,t=!1){return an.tidy((()=>{x(2===e.shape.length,(()=>`qr2d() requires a 2D Tensor, but got a ${e.shape.length}D Tensor.`));const n=e.shape[0],a=e.shape[1];let i=Ui(n),s=Ba(e);const r=dr([[1]],[1,1]);let o=Ba(r);const l=n>=a?a:n;for(let e=0;e<l;++e){const t=s,l=o,c=i;[o,s,i]=an.tidy((()=>{const t=Ga(s,[e,e],[n-e,1]),l=Mi(t),c=Ga(s,[e,e],[1,1]),u=wi(Vi(c,0),dr([[-1]]),dr([[1]])),h=es(c,Ta(u,l)),p=Na(t,h);o=1===p.shape[0]?Ba(r):Ua([r,Ga(p,[1,0],[p.shape[0]-1,p.shape[1]])],0);const d=ua(Na(oa(u,h),l)),f=Ga(s,[e,0],[n-e,a]),m=Ta(d,o),g=pa(o);if(0===e)s=es(f,oa(m,oa(g,f)));else{const t=es(f,oa(m,oa(g,f)));s=Ua([Ga(s,[0,0],[e,a]),t],0)}const v=pa(m),y=Ga(i,[0,e],[n,i.shape[1]-e]);if(0===e)i=es(y,oa(oa(y,o),v));else{const t=es(y,oa(oa(y,o),v));i=Ua([Ga(i,[0,0],[n,e]),t],1)}return[o,s,i]})),kn([t,l,c])}return!t&&n>a&&(i=Ga(i,[0,0],[n,a]),s=Ga(s,[0,0],[a,a])),[i,s]}))}const Zr={flipLeftRight:$r,grayscaleToRGB:Ar,resizeNearestNeighbor:Kr,resizeBilinear:Vr,rgbToGrayscale:Er,rotateWithOffset:jr,cropAndResize:Cr,nonMaxSuppression:Dr,nonMaxSuppressionAsync:Pr,nonMaxSuppressionWithScore:Br,nonMaxSuppressionWithScoreAsync:Ur,nonMaxSuppressionPadded:Wr,nonMaxSuppressionPaddedAsync:Gr,threshold:qr,transform:Hr},Yr={bandPart:pn({bandPart_:function(e,t,n){const a=un(e,"a","bandPart");x(a.rank>=2,(()=>`bandPart(): Rank must be at least 2, got ${a.rank}.`));const i=a.shape,[s,r]=a.shape.slice(-2);let o,l;"number"==typeof t?(x(t%1==0,(()=>`bandPart(): numLower must be an integer, got ${t}.`)),x(t<=s,(()=>`bandPart(): numLower (${t}) must not be greater than the number of rows (${s}).`)),o=un(t<0?s:t,"numLower","bandPart")):(x("int32"===t.dtype,(()=>"bandPart(): numLower's dtype must be an int32.")),o=wi(Hi(t,0),s,hs(t,s))),"number"==typeof n?(x(n%1==0,(()=>`bandPart(): numUpper must be an integer, got ${n}.`)),x(n<=r,(()=>`bandPart(): numUpper (${n}) must not be greater than the number of columns (${r}).`)),l=un(n<0?r:n,"numUpper","bandPart")):(x("int32"===n.dtype,(()=>"bandPart(): numUpper's dtype must be an int32.")),l=wi(Hi(n,0),r,hs(n,r)));const c=Ma(qs(0,s,1,"int32"),[-1,1]),u=qs(0,r,1,"int32"),h=es(c,u),p=as(Ji(h,o),Ki(h,ua(l))),d=cs([s,r],a.dtype);return Ma(ur(gr(Ma(a,[-1,s,r])).map((e=>wi(p,e,d)))),i)}}),gramSchmidt:pn({gramSchmidt_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e){let t;if(Array.isArray(e)){t=!1,x(null!=e&&e.length>0,(()=>"Gram-Schmidt process: input must not be null, undefined, or empty"));const n=e[0].shape[0];for(let t=1;t<e.length;++t)x(e[t].shape[0]===n,(()=>`Gram-Schmidt: Non-unique lengths found in the input vectors: (${e[t].shape[0]} vs. ${n})`))}else t=!0,e=lr(e,e.shape[0],0).map((e=>cr(e,[0])));x(e.length<=e[0].shape[0],(()=>`Gram-Schmidt: Number of vectors (${e.length}) exceeds number of dimensions (${e[0].shape[0]}).`));const n=[],a=e;for(let t=0;t<e.length;++t)n.push(an.tidy((()=>{let e=a[t];if(t>0)for(let a=0;a<t;++a){const t=Ta(Ri(Ta(n[a],e)),n[a]);e=es(e,t)}return Na(e,Mi(e,"euclidean"))})));return t?ur(n,0):n}}),qr:pn({qr_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t=!1){if(x(e.rank>=2,(()=>`qr() requires input tensor to have a rank >= 2, but got rank ${e.rank}`)),2===e.rank)return Jr(e,t);{const n=e.shape.slice(0,e.shape.length-2).reduce(((e,t)=>e*t)),a=gr(Ma(e,[n,e.shape[e.shape.length-2],e.shape[e.shape.length-1]]),0),i=[],s=[];a.forEach((e=>{const[n,a]=Jr(e,t);i.push(n),s.push(a)}));return[Ma(ur(i,0),e.shape),Ma(ur(s,0),e.shape)]}}})};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
class Qr extends ba{minimize(e,t=!1,n){const{value:a,grads:i}=this.computeGradients(e,n);if(null!=n){const e=n.map((e=>({name:e.name,tensor:i[e.name]})));this.applyGradients(e)}else this.applyGradients(i);return kn(i),t?a:(a.dispose(),null)}get iterations(){return null==this.iterations_&&(this.iterations_=0),this.iterations_}incrementIterations(){this.iterations_=this.iterations+1}computeGradients(e,t){return function(e,t){x(_(e),(()=>"The f passed in variableGrads(f) must be a function")),x(null==t||Array.isArray(t)&&t.every((e=>e instanceof Pt)),(()=>"The varList passed in variableGrads(f, varList) must be an array of variables"));const n=null!=t;if(!n){t=[];for(const e in an.registeredVariables)t.push(an.registeredVariables[e])}const a=n?t.filter((e=>!e.trainable)):null,i=t.length;t=t.filter((e=>e.trainable)),x(t.length>0,(()=>`variableGrads() expects at least one of the input variables to be trainable, but none of the ${i} variables is trainable.`));const{value:s,grads:r}=an.gradients(e,t,null,!0);x(r.some((e=>null!=e)),(()=>"Cannot find a connection between any variable and the result of the loss function y=f(x). Please make sure the operations that use variables are inside the function f passed to minimize().")),x(0===s.rank,(()=>`The f passed in variableGrads(f) must return a scalar, but it returned a rank-${s.rank} tensor`));const o={};return t.forEach(((e,t)=>{null!=r[t]&&(o[e.name]=r[t])})),null!=a&&a.forEach((e=>o[e.name]=null)),{value:s,grads:o}}(e,t)}dispose(){null!=this.iterations_&&kn(this.iterations_)}async saveIterations(){return null==this.iterations_&&(this.iterations_=0),{name:"iter",tensor:Di(this.iterations_,"int32")}}async getWeights(){throw new Error("getWeights() is not implemented for this optimizer yet.")}async setWeights(e){throw new Error(`setWeights() is not implemented for this optimizer class ${this.getClassName()}`)}async extractIterations(e){return this.iterations_=(await e[0].tensor.data())[0],e.slice(1)}}Object.defineProperty(Qr,Symbol.hasInstance,{value:e=>null!=e.minimize&&null!=e.computeGradients&&null!=e.applyGradients});
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
class Xr extends Qr{static get className(){return"Adadelta"}constructor(e,t,n=null){super(),this.learningRate=e,this.rho=t,this.epsilon=n,this.accumulatedGrads=[],this.accumulatedUpdates=[],null==n&&(this.epsilon=an.backend.epsilon())}applyGradients(e){(Array.isArray(e)?e.map((e=>e.name)):Object.keys(e)).forEach(((t,n)=>{const a=an.registeredVariables[t],i=!1;null==this.accumulatedGrads[n]&&(this.accumulatedGrads[n]={originalName:`${t}/accum_grad`,variable:wn((()=>ki(a).variable(i)))}),null==this.accumulatedUpdates[n]&&(this.accumulatedUpdates[n]={originalName:`${t}/accum_var`,variable:wn((()=>ki(a).variable(i)))});const s=Array.isArray(e)?e[n].tensor:e[t];if(null==s)return;const r=this.accumulatedGrads[n].variable,o=this.accumulatedUpdates[n].variable;wn((()=>{const e=xa(Ta(r,this.rho),Ta(_i(s),1-this.rho)),t=Ta(Na(Fi(xa(o,this.epsilon)),Fi(xa(r,this.epsilon))),s),n=xa(Ta(o,this.rho),Ta(_i(t),1-this.rho));r.assign(e),o.assign(n);const i=xa(Ta(t,-this.learningRate),a);a.assign(i)}))})),this.incrementIterations()}dispose(){null!=this.accumulatedUpdates&&(kn(this.accumulatedGrads.map((e=>e.variable))),kn(this.accumulatedUpdates.map((e=>e.variable))))}async getWeights(){const e=[...this.accumulatedGrads,...this.accumulatedUpdates];return[await this.saveIterations()].concat(e.map((e=>({name:e.originalName,tensor:e.variable}))))}async setWeights(e){const t=(e=await this.extractIterations(e)).length/2,n=!1;this.accumulatedGrads=e.slice(0,t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)}))),this.accumulatedUpdates=e.slice(t,2*t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)})))}getConfig(){return{learningRate:this.learningRate,rho:this.rho,epsilon:this.epsilon}}static fromConfig(e,t){return new e(t.learningRate,t.rho,t.epsilon)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class eo extends Qr{static get className(){return"Adagrad"}constructor(e,t=.1){super(),this.learningRate=e,this.initialAccumulatorValue=t,this.accumulatedGrads=[]}applyGradients(e){(Array.isArray(e)?e.map((e=>e.name)):Object.keys(e)).forEach(((t,n)=>{const a=an.registeredVariables[t];if(null==this.accumulatedGrads[n]){const e=!1;this.accumulatedGrads[n]={originalName:`${t}/accumulator`,variable:wn((()=>ei(a.shape,this.initialAccumulatorValue).variable(e)))}}const i=Array.isArray(e)?e[n].tensor:e[t];if(null==i)return;const s=this.accumulatedGrads[n].variable;wn((()=>{const e=xa(s,_i(i));s.assign(e);const t=xa(Ta(Na(i,Fi(xa(e,an.backend.epsilon()))),-this.learningRate),a);a.assign(t)}))})),this.incrementIterations()}dispose(){null!=this.accumulatedGrads&&kn(this.accumulatedGrads.map((e=>e.variable)))}async getWeights(){return[await this.saveIterations()].concat(this.accumulatedGrads.map((e=>({name:e.originalName,tensor:e.variable}))))}async setWeights(e){e=await this.extractIterations(e);this.accumulatedGrads=e.map((e=>({originalName:e.name,variable:e.tensor.variable(false)})))}getConfig(){return{learningRate:this.learningRate,initialAccumulatorValue:this.initialAccumulatorValue}}static fromConfig(e,t){return new e(t.learningRate,t.initialAccumulatorValue)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class to extends Qr{static get className(){return"Adam"}constructor(e,t,n,a=null){super(),this.learningRate=e,this.beta1=t,this.beta2=n,this.epsilon=a,this.accumulatedFirstMoment=[],this.accumulatedSecondMoment=[],wn((()=>{this.accBeta1=Di(t).variable(),this.accBeta2=Di(n).variable()})),null==a&&(this.epsilon=an.backend.epsilon())}applyGradients(e){const t=Array.isArray(e)?e.map((e=>e.name)):Object.keys(e);wn((()=>{const n=es(1,this.accBeta1),a=es(1,this.accBeta2);t.forEach(((t,i)=>{const s=an.registeredVariables[t],r=!1;null==this.accumulatedFirstMoment[i]&&(this.accumulatedFirstMoment[i]={originalName:`${t}/m`,variable:wn((()=>ki(s).variable(r)))}),null==this.accumulatedSecondMoment[i]&&(this.accumulatedSecondMoment[i]={originalName:`${t}/v`,variable:wn((()=>ki(s).variable(r)))});const o=Array.isArray(e)?e[i].tensor:e[t];if(null==o)return;const l=this.accumulatedFirstMoment[i].variable,c=this.accumulatedSecondMoment[i].variable,u=xa(Ta(l,this.beta1),Ta(o,1-this.beta1)),h=xa(Ta(c,this.beta2),Ta(_i(o),1-this.beta2)),p=Na(u,n),d=Na(h,a);l.assign(u),c.assign(h);const f=xa(Ta(Na(p,xa(Fi(d),this.epsilon)),-this.learningRate),s);s.assign(f)})),this.accBeta1.assign(Ta(this.accBeta1,this.beta1)),this.accBeta2.assign(Ta(this.accBeta2,this.beta2))})),this.incrementIterations()}dispose(){this.accBeta1.dispose(),this.accBeta2.dispose(),null!=this.accumulatedFirstMoment&&kn(this.accumulatedFirstMoment.map((e=>e.variable))),null!=this.accumulatedSecondMoment&&kn(this.accumulatedSecondMoment.map((e=>e.variable)))}async getWeights(){const e=[...this.accumulatedFirstMoment,...this.accumulatedSecondMoment];return[await this.saveIterations()].concat(e.map((e=>({name:e.originalName,tensor:e.variable}))))}async setWeights(e){e=await this.extractIterations(e),wn((()=>{this.accBeta1.assign(zi(this.beta1,this.iterations_+1)),this.accBeta2.assign(zi(this.beta2,this.iterations_+1))}));const t=e.length/2,n=!1;this.accumulatedFirstMoment=e.slice(0,t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)}))),this.accumulatedSecondMoment=e.slice(t,2*t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)})))}getConfig(){return{learningRate:this.learningRate,beta1:this.beta1,beta2:this.beta2,epsilon:this.epsilon}}static fromConfig(e,t){return new e(t.learningRate,t.beta1,t.beta2,t.epsilon)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class no extends Qr{static get className(){return"Adamax"}constructor(e,t,n,a=null,i=0){super(),this.learningRate=e,this.beta1=t,this.beta2=n,this.epsilon=a,this.decay=i,this.accumulatedFirstMoment=[],this.accumulatedWeightedInfNorm=[],wn((()=>{this.iteration=Di(0).variable(),this.accBeta1=Di(t).variable()})),null==a&&(this.epsilon=an.backend.epsilon())}applyGradients(e){const t=Array.isArray(e)?e.map((e=>e.name)):Object.keys(e);wn((()=>{const n=es(1,this.accBeta1),a=Na(-this.learningRate,xa(Ta(this.iteration,this.decay),1));t.forEach(((t,i)=>{const s=an.registeredVariables[t],r=!1;null==this.accumulatedFirstMoment[i]&&(this.accumulatedFirstMoment[i]={originalName:`${t}/m`,variable:ki(s).variable(r)}),null==this.accumulatedWeightedInfNorm[i]&&(this.accumulatedWeightedInfNorm[i]={originalName:`${t}/v`,variable:ki(s).variable(r)});const o=Array.isArray(e)?e[i].tensor:e[t];if(null==o)return;const l=this.accumulatedFirstMoment[i].variable,c=this.accumulatedWeightedInfNorm[i].variable,u=xa(Ta(l,this.beta1),Ta(o,1-this.beta1)),h=Ta(c,this.beta2),p=Ia(o),d=os(h,p);l.assign(u),c.assign(d);const f=xa(Ta(Na(a,n),Na(u,xa(d,this.epsilon))),s);s.assign(f)})),this.iteration.assign(xa(this.iteration,1)),this.accBeta1.assign(Ta(this.accBeta1,this.beta1))})),this.incrementIterations()}dispose(){this.accBeta1.dispose(),this.iteration.dispose(),null!=this.accumulatedFirstMoment&&kn(this.accumulatedFirstMoment.map((e=>e.variable))),null!=this.accumulatedWeightedInfNorm&&kn(this.accumulatedWeightedInfNorm.map((e=>e.variable)))}async getWeights(){throw new Error("getWeights() is not implemented for Adamax yet.")}async setWeights(e){throw new Error("setWeights() is not implemented for Adamax yet.")}getConfig(){return{learningRate:this.learningRate,beta1:this.beta1,beta2:this.beta2,epsilon:this.epsilon,decay:this.decay}}static fromConfig(e,t){return new e(t.learningRate,t.beta1,t.beta2,t.epsilon,t.decay)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class ao extends Qr{static get className(){return"SGD"}constructor(e){super(),this.learningRate=e,this.setLearningRate(e)}applyGradients(e){(Array.isArray(e)?e.map((e=>e.name)):Object.keys(e)).forEach(((t,n)=>{const a=Array.isArray(e)?e[n].tensor:e[t];if(null==a)return;const i=an.registeredVariables[t];wn((()=>{const e=xa(Ta(this.c,a),i);i.assign(e)}))})),this.incrementIterations()}setLearningRate(e){this.learningRate=e,null!=this.c&&this.c.dispose(),this.c=xn(Di(-e))}dispose(){this.c.dispose()}async getWeights(){return[await this.saveIterations()]}async setWeights(e){if(0!==(e=await this.extractIterations(e)).length)throw new Error("SGD optimizer does not have settable weights.")}getConfig(){return{learningRate:this.learningRate}}static fromConfig(e,t){return new e(t.learningRate)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class io extends ao{static get className(){return"Momentum"}constructor(e,t,n=!1){super(e),this.learningRate=e,this.momentum=t,this.useNesterov=n,this.accumulations=[],this.m=Di(this.momentum)}applyGradients(e){(Array.isArray(e)?e.map((e=>e.name)):Object.keys(e)).forEach(((t,n)=>{const a=an.registeredVariables[t];if(null==this.accumulations[n]){const e=!1;this.accumulations[n]={originalName:`${t}/momentum`,variable:wn((()=>ki(a).variable(e)))}}const i=this.accumulations[n].variable,s=Array.isArray(e)?e[n].tensor:e[t];null!=s&&wn((()=>{let e;const t=xa(Ta(this.m,i),s);e=this.useNesterov?xa(Ta(this.c,xa(s,Ta(t,this.m))),a):xa(Ta(this.c,t),a),i.assign(t),a.assign(e)}))})),this.incrementIterations()}dispose(){this.m.dispose(),null!=this.accumulations&&kn(this.accumulations.map((e=>e.variable)))}setMomentum(e){this.momentum=e}async getWeights(){return[await this.saveIterations()].concat(this.accumulations.map((e=>({name:e.originalName,tensor:e.variable}))))}async setWeights(e){e=await this.extractIterations(e);this.accumulations=e.map((e=>({originalName:e.name,variable:e.tensor.variable(false)})))}getConfig(){return{learningRate:this.learningRate,momentum:this.momentum,useNesterov:this.useNesterov}}static fromConfig(e,t){return new e(t.learningRate,t.momentum,t.useNesterov)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */class so extends Qr{static get className(){return"RMSProp"}constructor(e,t=.9,n=0,a=null,i=!1){if(super(),this.learningRate=e,this.decay=t,this.momentum=n,this.epsilon=a,this.accumulatedMeanSquares=[],this.accumulatedMoments=[],this.accumulatedMeanGrads=[],this.centered=i,null==a&&(this.epsilon=an.backend.epsilon()),null==e)throw new Error("learningRate for RMSPropOptimizer must be defined.")}applyGradients(e){(Array.isArray(e)?e.map((e=>e.name)):Object.keys(e)).forEach(((t,n)=>{const a=an.registeredVariables[t],i=!1;null==this.accumulatedMeanSquares[n]&&(this.accumulatedMeanSquares[n]={originalName:`${t}/rms`,variable:wn((()=>ki(a).variable(i)))}),null==this.accumulatedMoments[n]&&(this.accumulatedMoments[n]={originalName:`${t}/momentum`,variable:wn((()=>ki(a).variable(i)))}),null==this.accumulatedMeanGrads[n]&&this.centered&&(this.accumulatedMeanGrads[n]={originalName:`${t}/mg`,variable:wn((()=>ki(a).variable(i)))});const s=Array.isArray(e)?e[n].tensor:e[t];if(null==s)return;const r=this.accumulatedMeanSquares[n].variable,o=this.accumulatedMoments[n].variable;wn((()=>{const e=xa(Ta(r,this.decay),Ta(_i(s),1-this.decay));if(this.centered){const t=this.accumulatedMeanGrads[n].variable,i=xa(Ta(t,this.decay),Ta(s,1-this.decay)),l=Na(Ta(s,this.learningRate),Fi(es(e,xa(_i(i),this.epsilon)))),c=xa(Ta(o,this.momentum),l);r.assign(e),t.assign(i),o.assign(c);const u=es(a,c);a.assign(u)}else{const e=xa(Ta(r,this.decay),Ta(_i(s),1-this.decay)),t=xa(Ta(o,this.momentum),Na(Ta(s,this.learningRate),Fi(xa(e,this.epsilon))));r.assign(e),o.assign(t);const n=es(a,t);a.assign(n)}}))})),this.incrementIterations()}dispose(){null!=this.accumulatedMeanSquares&&kn(this.accumulatedMeanSquares.map((e=>e.variable))),null!=this.accumulatedMeanGrads&&this.centered&&kn(this.accumulatedMeanGrads.map((e=>e.variable))),null!=this.accumulatedMoments&&kn(this.accumulatedMoments.map((e=>e.variable)))}async getWeights(){const e=[...this.accumulatedMeanSquares,...this.accumulatedMoments];return this.centered&&e.push(...this.accumulatedMeanGrads),[await this.saveIterations()].concat(e.map((e=>({name:e.originalName,tensor:e.variable}))))}async setWeights(e){e=await this.extractIterations(e);const t=this.centered?e.length/3:e.length/2,n=!1;this.accumulatedMeanSquares=e.slice(0,t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)}))),this.accumulatedMoments=e.slice(t,2*t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)}))),this.centered&&(this.accumulatedMeanGrads=e.slice(2*t,3*t).map((e=>({originalName:e.name,variable:e.tensor.variable(n)}))))}getConfig(){return{learningRate:this.learningRate,decay:this.decay,momentum:this.momentum,epsilon:this.epsilon,centered:this.centered}}static fromConfig(e,t){return new e(t.learningRate,t.decay,t.momentum,t.epsilon,t.centered)}}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const ro=class{static sgd(e){return new ao(e)}static momentum(e,t,n=!1){return new io(e,t,n)}static rmsprop(e,t=.9,n=0,a=null,i=!1){return new so(e,t,n,a,i)}static adam(e=.001,t=.9,n=.999,a=null){return new to(e,t,n,a)}static adadelta(e=.001,t=.95,n=null){return new Xr(e,t,n)}static adamax(e=.002,t=.9,n=.999,a=null,i=0){return new no(e,t,n,a,i)}static adagrad(e,t=.1){return new eo(e,t)}},oo="undefined"!=typeof requestAnimationFrame?requestAnimationFrame:"undefined"!=typeof setImmediate?setImmediate:e=>e();
/**
     * @license
     * Copyright 2017 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function lo(){return new Promise((e=>oo((()=>e()))))}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function co(e,t){if(e.length!==t.length)throw new Error(`Cannot merge real and imag arrays of different lengths. real:${e.length}, imag: ${t.length}.`);const n=new Float32Array(2*e.length);for(let a=0;a<n.length;a+=2)n[a]=e[a/2],n[a+1]=t[a/2];return n}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function uo(e){try{return e.map((e=>Nt(e)))}catch(e){throw new Error(`Failed to decode encoded string bytes into utf-8, error: ${e}`)}}
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
class ho{constructor(){this.messageName="setTimeoutCustom",this.functionRefs=[],this.handledMessageCount=0,this.hasEventListener=!1}fetch(e,t){return fetch(e,t)}now(){return performance.now()}encode(e,t){if("utf-8"!==t&&"utf8"!==t)throw new Error(`Browser's encoder only supports utf-8, but got ${t}`);return null==this.textEncoder&&(this.textEncoder=new TextEncoder),this.textEncoder.encode(e)}decode(e,t){return new TextDecoder(t).decode(e)}setTimeoutCustom(e,t){"undefined"!=typeof window&&H().getBool("USE_SETTIMEOUTCUSTOM")?(this.functionRefs.push(e),setTimeout((()=>{window.postMessage({name:this.messageName,index:this.functionRefs.length-1},"*")}),t),this.hasEventListener||(this.hasEventListener=!0,window.addEventListener("message",(e=>{if(e.source===window&&e.data.name===this.messageName){e.stopPropagation();(0,this.functionRefs[e.data.index])(),this.handledMessageCount++,this.handledMessageCount===this.functionRefs.length&&(this.functionRefs=[],this.handledMessageCount=0)}}),!0))):setTimeout(e,t)}isTypedArray(e){return wt(e)}}if(H().get("IS_BROWSER")){H().setPlatform("browser",new ho);try{sa.registerManager(Yn.URL_SCHEME,new Xn)}catch(e){}try{sa.registerManager(Mn.URL_SCHEME,new Pn)}catch(e){}}
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const po=()=>require("node-fetch");let fo;class mo{constructor(){this.util=require("util"),this.textEncoder=new this.util.TextEncoder}fetch(e,t){return null!=H().global.fetch?H().global.fetch(e,t):(null==fo&&(fo=po()),fo(e,t))}now(){const e=process.hrtime();return 1e3*e[0]+e[1]/1e6}encode(e,t){if("utf-8"!==t&&"utf8"!==t)throw new Error(`Node built-in encoder only supports utf-8, but got ${t}`);return this.textEncoder.encode(e)}decode(e,t){return 0===e.length?"":new this.util.TextDecoder(t).decode(e)}isTypedArray(e){return this.util.types.isFloat32Array(e)||this.util.types.isInt32Array(e)||this.util.types.isUint8Array(e)||this.util.types.isUint8ClampedArray(e)}}H().get("IS_NODE")&&!H().get("IS_BROWSER")&&H().setPlatform("node",new mo),
/**
     * @license
     * Copyright 2020 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
nn();Lt={buffer:Xa,cast:ra,clone:Ba,print:function(e,t=!1){console.log(e.toString(t))}};
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     *
     * =============================================================================
     */
var go,vo;
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function yo(e,t){Array.isArray(e)||(e=[e]),e.forEach((e=>{null!=e&&x("complex64"!==e.dtype,(()=>`${t} does not support complex64 tensors in the CPU backend.`))}))}
/**
     * @license
     * Copyright 2021 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */H().registerFlag("KEEP_INTERMEDIATE_TENSORS",(()=>!1),(e=>{e&&console.warn("Keep intermediate tensors is ON. This will print the values of all intermediate tensors during model inference. Not all models support this mode. For details, check e2e/benchmarks/ model_config.js. This significantly impacts performance.")})),function(e){e[e.DT_INVALID=0]="DT_INVALID",e[e.DT_FLOAT=1]="DT_FLOAT",e[e.DT_DOUBLE=2]="DT_DOUBLE",e[e.DT_INT32=3]="DT_INT32",e[e.DT_UINT8=4]="DT_UINT8",e[e.DT_INT16=5]="DT_INT16",e[e.DT_INT8=6]="DT_INT8",e[e.DT_STRING=7]="DT_STRING",e[e.DT_COMPLEX64=8]="DT_COMPLEX64",e[e.DT_INT64=9]="DT_INT64",e[e.DT_BOOL=10]="DT_BOOL",e[e.DT_QINT8=11]="DT_QINT8",e[e.DT_QUINT8=12]="DT_QUINT8",e[e.DT_QINT32=13]="DT_QINT32",e[e.DT_BFLOAT16=14]="DT_BFLOAT16",e[e.DT_QINT16=15]="DT_QINT16",e[e.DT_QUINT16=16]="DT_QUINT16",e[e.DT_UINT16=17]="DT_UINT16",e[e.DT_COMPLEX128=18]="DT_COMPLEX128",e[e.DT_HALF=19]="DT_HALF",e[e.DT_RESOURCE=20]="DT_RESOURCE",e[e.DT_VARIANT=21]="DT_VARIANT",e[e.DT_UINT32=22]="DT_UINT32",e[e.DT_UINT64=23]="DT_UINT64",e[e.DT_FLOAT_REF=101]="DT_FLOAT_REF",e[e.DT_DOUBLE_REF=102]="DT_DOUBLE_REF",e[e.DT_INT32_REF=103]="DT_INT32_REF",e[e.DT_UINT8_REF=104]="DT_UINT8_REF",e[e.DT_INT16_REF=105]="DT_INT16_REF",e[e.DT_INT8_REF=106]="DT_INT8_REF",e[e.DT_STRING_REF=107]="DT_STRING_REF",e[e.DT_COMPLEX64_REF=108]="DT_COMPLEX64_REF",e[e.DT_INT64_REF=109]="DT_INT64_REF",e[e.DT_BOOL_REF=110]="DT_BOOL_REF",e[e.DT_QINT8_REF=111]="DT_QINT8_REF",e[e.DT_QUINT8_REF=112]="DT_QUINT8_REF",e[e.DT_QINT32_REF=113]="DT_QINT32_REF",e[e.DT_BFLOAT16_REF=114]="DT_BFLOAT16_REF",e[e.DT_QINT16_REF=115]="DT_QINT16_REF",e[e.DT_QUINT16_REF=116]="DT_QUINT16_REF",e[e.DT_UINT16_REF=117]="DT_UINT16_REF",e[e.DT_COMPLEX128_REF=118]="DT_COMPLEX128_REF",e[e.DT_HALF_REF=119]="DT_HALF_REF",e[e.DT_RESOURCE_REF=120]="DT_RESOURCE_REF",e[e.DT_VARIANT_REF=121]="DT_VARIANT_REF",e[e.DT_UINT32_REF=122]="DT_UINT32_REF",e[e.DT_UINT64_REF=123]="DT_UINT64_REF"}(go||(go={})),function(e){var t;(t=e.CheckpointFormatVersion||(e.CheckpointFormatVersion={}))[t.LEGACY=0]="LEGACY",t[t.V1=1]="V1",t[t.V2=2]="V2"}(vo||(vo={}));const bo=
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t){const n=[];for(let e=0;e<t.length;e++)t[e]&&n.push(e);const a=Xa(e,"int32"),i=Xa([n.length,e.length],"int32");for(let t=0;t<n.length;t++){const s=a.indexToLoc(n[t]),r=t*e.length;i.values.set(s,r)}return i.toTensor()};class wo extends y{nextDataId(){return wo.nextDataId++}constructor(){super(),this.blockSize=48,this.firstUse=!0,this.data=new v(this,yn())}write(e,t,n){this.firstUse&&(this.firstUse=!1,H().get("IS_NODE")&&ht("\n============================\nHi, looks like you are running TensorFlow.js in Node.js. To speed things up dramatically, install our node backend, visit https://github.com/tensorflow/tfjs-node for more details. \n============================"));const a={id:this.nextDataId()};return this.data.set(a,{values:e,dtype:n,refCount:1}),a}makeTensorInfo(e,t,n){let a;if("string"===t&&null!=n&&n.length>0&&z(n[0])){const i=n.map((e=>St(e)));a=this.write(i,e,t)}else a=this.write(n,e,t);return{dataId:a,shape:e,dtype:t}}refCount(e){if(this.data.has(e)){return this.data.get(e).refCount}return 0}incRef(e){this.data.get(e).refCount++}decRef(e){if(this.data.has(e)){this.data.get(e).refCount--}}move(e,t,n,a,i){this.data.set(e,{values:t,dtype:a,refCount:i})}numDataIds(){return this.data.numDataIds()}async read(e){return this.readSync(e)}readSync(e){const{dtype:t,complexTensorInfos:n}=this.data.get(e);if("complex64"===t){return co(this.readSync(n.real.dataId),this.readSync(n.imag.dataId))}return function(e,t){if(Array.isArray(e))return e;if("float32"===t)return e instanceof Float32Array?e:new Float32Array(e);if("int32"===t)return e instanceof Int32Array?e:new Int32Array(e);if("bool"===t||"string"===t)return Uint8Array.from(new Int32Array(e));throw new Error(`Unknown dtype ${t}`)}(this.data.get(e).values,t)}bufferSync(e){const t=this.readSync(e.dataId);if("string"===e.dtype)try{const n=t.map((e=>Nt(e)));return Xa(e.shape,e.dtype,n)}catch(e){throw new Error("Failed to decode encoded string bytes into utf-8")}return Xa(e.shape,e.dtype,t)}makeOutput(e,t,n){return yn().makeTensorFromTensorInfo(this.makeTensorInfo(t,n,e),this)}disposeData(e,t=!1){if(this.data.has(e)){if(this.data.get(e).refCount--,!t&&this.data.get(e).refCount>0)return!1;const{complexTensorInfos:n}=this.data.get(e);null!=n&&(this.disposeData(n.real.dataId,!0),this.disposeData(n.imag.dataId,!0)),this.data.delete(e)}return!0}disposeIntermediateTensorInfo(e){this.disposeData(e.dataId)}async time(e){const t=xt();e();return{kernelMs:xt()-t}}memory(){return{unreliable:!0,reasons:["The reported memory is an upper bound. Due to automatic garbage collection, the true allocated memory may be less."]}}where(e){yo([e],"where");const t=this.readSync(e.dataId);return bo(e.shape,t)}dispose(){}floatPrecision(){return 32}epsilon(){return super.epsilon()}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function ko(e){return(t,n,a,i,s)=>{const r=ma(t,n),o=r.length,l=R(r),c=A(s,N(r)),u=t.length,h=n.length,p=R(t),d=R(n),f=da(t,r),m=da(n,r);if(f.length+m.length===0)for(let t=0;t<c.length;++t)c[t]=e(a[t%a.length],i[t%i.length]);else for(let t=0;t<c.length;++t){const n=W(t,o,l),s=n.slice(-u);f.forEach((e=>s[e]=0));const r=U(s,u,p),g=n.slice(-h);m.forEach((e=>g[e]=0));const v=U(g,h,d);c[t]=e(a[r],i[v])}return[c,r]}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function xo(e){const{inputs:t,backend:n}=e,{real:a,imag:i}=t,s=n.data.get(a.dataId).values,r=n.data.get(i.dataId).values,o=n.makeTensorInfo(a.shape,"complex64");return n.data.get(o.dataId).complexTensorInfos={real:n.makeTensorInfo(a.shape,"float32",s),imag:n.makeTensorInfo(i.shape,"float32",r)},o}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function So(e,t,n="float32"){if("complex64"===n){return xo({inputs:{real:So(e,t,"float32"),imag:So(e,t,"float32")},backend:e})}const a=P(N(t),n);return e.makeTensorInfo(t,n,a)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function No(e){const{inputs:t,backend:n}=e,{x:a}=t;return n.incRef(a.dataId),{dataId:a.dataId,shape:a.shape,dtype:a.dtype}}wo.nextDataId=0;const To={kernelName:Se,backendName:"cpu",kernelFunc:No};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Io(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{dtype:s}=a;if("complex64"===s){if("complex64"===i.dtype)return No({inputs:{x:i},backend:n});const e=So(n,i.shape,i.dtype),t=Io({inputs:{x:i},backend:n,attrs:{dtype:"float32"}}),a=xo({inputs:{real:t,imag:e},backend:n});return n.disposeIntermediateTensorInfo(e),n.disposeIntermediateTensorInfo(t),a}if("complex64"===i.dtype){const e=function(e){const{inputs:t,backend:n}=e,{input:a}=t,i=n.data.get(a.dataId).complexTensorInfos.real,s=n.data.get(i.dataId).values;return n.makeTensorInfo(i.shape,i.dtype,s)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */({inputs:{input:i},backend:n}),t=Io({inputs:{x:e},backend:n,attrs:{dtype:s}});return n.disposeIntermediateTensorInfo(e),t}if(r=i.dtype,"complex64"===(o=s)||"float32"===o&&"complex64"!==r||"int32"===o&&"float32"!==r&&"complex64"!==r||"bool"===o&&"bool"===r){const e=No({inputs:{x:i},backend:n});return{dataId:e.dataId,shape:e.shape,dtype:s}}var r,o;const l=n.data.get(i.dataId).values,[c,u,h]=function(e,t,n,a){if("int32"===a)return[t,"int32",Int32Array.from(e)];if("bool"===a){const a=kt([0],n),[i,s]=ko(((e,t)=>e!==t?1:0))(t,[],e,a,"bool");return[s,"bool",i]}throw new Error(`Error in Cast: failed to cast ${n} to ${a}`)}(l,i.shape,i.dtype,s);return n.makeTensorInfo(c,u,h)}const Co={kernelName:se,backendName:"cpu",kernelFunc:Io};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const $o=ko(((e,t)=>e+t)),Ao=function(e){return(t,n,a,i,s,r)=>{const o=ma(t,n),l=N(o),c=o.length,u=R(o),h=A("float32",l),p=A("float32",l),d=da(t,o),f=da(n,o),m=co(a,i),g=co(s,r),v=t.length,y=R(t),b=n.length,w=R(n);if(d.length+f.length===0)for(let t=0;t<h.length;t++){const n=t%m.length,a=t%g.length,i=e(m[2*n],m[2*n+1],g[2*a],g[2*a+1]);h[t]=i.real,p[t]=i.imag}else for(let t=0;t<h.length;t++){const n=W(t,c,u),a=n.slice(-v);d.forEach((e=>a[e]=0));const i=U(a,v,y),s=n.slice(-b);f.forEach((e=>s[e]=0));const r=U(s,b,w),o=e(m[2*i],m[2*i+1],g[2*r],g[2*r+1]);h[t]=o.real,p[t]=o.imag}return[h,p,o]}}(((e,t,n,a)=>({real:e+n,imag:t+a}))),Eo=(jo=X,zo=$o,null==(Do=Ao)?({inputs:e,backend:t})=>{const{a:n,b:a}=e,i=t;yo([n,a],jo);const s=i.data.get(n.dataId).values,r=i.data.get(a.dataId).values,o="string"===n.dtype?uo(s):s,l="string"===n.dtype?uo(r):r,c=n.dtype,[u,h]=zo(n.shape,a.shape,o,l,c);return i.makeTensorInfo(h,c,u)}:({inputs:e,backend:t})=>{const{a:n,b:a}=e,i=t;if("complex64"===n.dtype||"complex64"===a.dtype){const e=Io({inputs:{x:n},backend:i,attrs:{dtype:"complex64"}}),t=i.data.get(e.dataId),s=t.complexTensorInfos.real,r=t.complexTensorInfos.imag,o=i.data.get(s.dataId).values,l=i.data.get(r.dataId).values,c=Io({inputs:{x:a},backend:i,attrs:{dtype:"complex64"}}),u=i.data.get(c.dataId),h=u.complexTensorInfos.real,p=u.complexTensorInfos.imag,d=i.data.get(h.dataId).values,f=i.data.get(p.dataId).values,[m,g,v]=Do(n.shape,a.shape,o,l,d,f),y=i.makeTensorInfo(v,"float32",m),b=i.makeTensorInfo(v,"float32",g),w=xo({inputs:{real:y,imag:b},backend:i});return i.disposeIntermediateTensorInfo(e),i.disposeIntermediateTensorInfo(c),i.disposeIntermediateTensorInfo(y),i.disposeIntermediateTensorInfo(b),w}{const e=i.data.get(n.dataId).values,t=i.data.get(a.dataId).values,s=n.dtype,[r,o]=zo(n.shape,a.shape,e,t,s);return i.makeTensorInfo(o,s,r)}});var jo,zo,Do;const Fo={kernelName:X,backendName:"cpu",kernelFunc:Eo};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function _o(e,t,n){const a=function(e){return(t,n,a)=>{const i=E(n,t.length);for(let n=0;n<t.length;++n)i[n]=e(t[n],a);return i}}(t);return function(e,t){return({inputs:n,attrs:a,backend:i})=>{const{x:s}=n;yo(s,e);const r=i,o=r.data.get(s.dataId).values;let l;if("string"===s.dtype){if(!Array.isArray(o))throw new Error("String tensor's value was not an instance of Array");l=uo(o)}else l=o;const c=s.dtype,u=t(l,c,a);return r.makeTensorInfo(s.shape,c,u)}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(e,a)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function Ro(e){const{inputs:t,attrs:n,backend:a}=e,{x:i}=t,{perm:s}=n;yo(i,"transpose");const r=i.shape.length,o=new Array(r);for(let e=0;e<o.length;e++)o[e]=i.shape[s[e]];const l=
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i){const s=t.length,r=N(t),o=R(t),l=R(i),c=A(n,N(i));for(let t=0;t<r;++t){const n=W(t,s,o),i=new Array(n.length);for(let e=0;e<i.length;e++)i[e]=n[a[e]];c[U(i,s,l)]=e[t]}return c}(a.data.get(i.dataId).values,i.shape,i.dtype,s,o);return{dataId:a.write(l,o,i.dtype),shape:o,dtype:i.dtype}}const Lo={kernelName:it,backendName:"cpu",kernelFunc:Ro},Mo=_o(Je,(e=>1/(1+Math.exp(-e)))),Oo={kernelName:Je,backendName:"cpu",kernelFunc:Mo};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function Po(e,t,n,a,i){const s=function(e,t,n){let a=n.length;for(let e=0;e<n.length;e++)if(n[e]>1){a=e;break}for(let i=a+1;i<n.length;i++)if(t[i]>0||n[i]!==e[i])return!1;return!0}(a,t,n),r=N(n),o=R(a);if(s){const n=function(e,t){let n=e.length>0?e[e.length-1]:1;for(let a=0;a<e.length-1;a++)n+=e[a]*t[a];return n}(t,o);return"string"===i?e.slice(n,n+r):e.subarray(n,n+r)}const l=Xa(a,i,"string"===i?uo(e):e),c=Xa(n,i);for(let e=0;e<c.size;++e){const n=c.indexToLoc(e),a=n.map(((e,n)=>e+t[n]));c.set(l.get(...a),...n)}return"string"===i?c.values.map((e=>St(e))):c.values}function Bo(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{begin:s,size:r}=a;yo(i,"slice");const[o,l]=ga(i,s,r);!function(e,t,n){const a=e.shape.length;x(a===t.length,(()=>`Error in slice${a}D: Length of begin ${t} must match the rank of the array (${a}).`)),x(a===n.length,(()=>`Error in slice${a}D: Length of size ${n} must match the rank of the array (${a}).`));for(let i=0;i<a;++i)x(t[i]+n[i]<=e.shape[i],(()=>`Error in slice${a}D: begin[${i}] + size[${i}] (${t[i]+n[i]}) would overflow input.shape[${i}] (${e.shape[i]})`))}(i,o,l);const c=Po(n.data.get(i.dataId).values,o,l,i.shape,i.dtype);return n.makeTensorInfo(l,i.dtype,c)}const Uo={kernelName:qe,backendName:"cpu",kernelFunc:Bo};
/**
     * @license
     * Copyright 2019 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function Wo(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{shape:s}=a,r=N(i.shape),o=function(e,t){let n=1,a=-1;for(let t=0;t<e.length;++t)if(e[t]>=0)n*=e[t];else if(-1===e[t]){if(-1!==a)throw Error(`Shapes can only have 1 implicit size. Found -1 at dim ${a} and dim ${t}`);a=t}else if(e[t]<0)throw Error(`Shapes can not be < 0. Found ${e[t]} at dim ${t}`);if(-1===a){if(t>0&&t!==n)throw Error(`Size(${t}) must match the product of shape ${e}`);return e}if(0===n)throw Error(`Cannot infer the missing size in [${e}] when there are 0 elements`);if(t%n!=0)throw Error(`The implicit shape can't be a fractional number. Got ${t} / ${n}`);const i=e.slice();return i[a]=t/n,i}(s,r),l=N(o);x(r===l,(()=>`The new shape (${o}) has ${l} elements and the old shape (${i.shape}) has ${r} elements. The new shape and old shape must have the same number of elements.`)),n.incRef(i.dataId);const c=n.data.get(i.dataId);if(null!=c.complexTensorInfos){const e=c.complexTensorInfos.real,t=c.complexTensorInfos.imag;e.shape=o,t.shape=o}return{dataId:i.dataId,shape:o,dtype:i.dtype}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
!function(e,t,n=1){an.registerBackend(e,t,n)}("cpu",(()=>new wo),1);const Go={kernelName:Me,backendName:"cpu",kernelFunc:Wo};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Vo={kernelName:ke,backendName:"cpu",kernelFunc:function(e){const{inputs:t,backend:n,attrs:a}=e,{x:i,indices:s}=t,{axis:r,batchDims:o}=a;yo([i,s],"gatherV2");const l=$(r,i.shape)[0],c=n.data.get(s.dataId).values,u=i.shape[l];for(let e=0;e<c.length;++e){const t=c[e];x(t<=u-1&&t>=0,(()=>`GatherV2: the index value ${t} is not in [0, ${u-1}]`))}let h=o;null==o&&(h=0);const p=N(s.shape),d=function(e,t,n,a){const i=t.shape.length,s=e.shape.length;if(0!==a&&(a<-i||a>i))throw new Error(`Expect batchDims in the range of [-${i}, ${i}], but got ${a}`);if(a<0&&(a+=i),a>s)throw new Error(`batchDims (${a}) must be less than rank(x) (\n    ${s}).`);if(n<a)throw new Error(`batchDims (${a}) must be less than or equal to axis (${n}).`);for(let n=0;n<a;++n)if(e.shape[n]!==t.shape[n])throw new Error(`x.shape[${n}]: ${e.shape[n]} should be equal to indices.shape[${n}]: ${t.shape[n]}.`);const r=e.shape[n],o=[];let l=1,c=1,u=1;for(let t=0;t<a;++t)o.push(e.shape[t]),l*=e.shape[t];for(let t=a;t<n;t++)o.push(e.shape[t]),c*=e.shape[t];for(let e=a;e<i;e++)o.push(t.shape[e]);for(let t=n+1;t<s;t++)o.push(e.shape[t]),u*=e.shape[t];return{batchSize:l,sliceSize:u,outerSize:c,dimSize:r,outputShape:o}}(i,s,l,h),f=Wo({inputs:{x:i},backend:n,attrs:{shape:[d.batchSize,d.outerSize,d.dimSize,d.sliceSize]}}),m=Wo({inputs:{x:s},backend:n,attrs:{shape:[d.batchSize,p/d.batchSize]}}),g=[d.batchSize,d.outerSize,p/d.batchSize,d.sliceSize],v=n.bufferSync(m),y=function(e,t,n){const a=Xa(n,e.dtype);for(let n=0;n<a.size;++n){const i=a.indexToLoc(n).slice(),s=i[0],r=i[2],o=t.locToIndex([s,r]);i[2]=t.values[o];const l=e.locToIndex(i);0<=l&&l<e.values.length&&(a.values[n]=e.values[l])}return a}(n.bufferSync(f),v,g);return n.disposeIntermediateTensorInfo(f),n.disposeIntermediateTensorInfo(m),n.makeTensorInfo(d.outputShape,y.dtype,y.values)}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ko={kernelName:Qe,backendName:"cpu",kernelFunc:function(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{axis:s,keepDims:r}=a;let o;yo(i,"sum"),o="bool"===i.dtype?Io({inputs:{x:i},backend:n,attrs:{dtype:"int32"}}):No({inputs:{x:i},backend:n});const l=o.shape.length,c=$(s,o.shape),u=$i(c,l);let h=c,p=o;null!=u&&(p=Ro({inputs:{x:o},backend:n,attrs:{perm:u}}),h=function(e,t){const n=[];for(let a=t-e;a<t;++a)n.push(a);return n}(h.length,l)),function(e,t,n){x(Ti(t,n),(()=>`${e} supports only inner-most axes for now. Got axes ${t} and rank-${n} input.`))}("sum",h,p.shape.length);const[d,f]=Ii(p.shape,h);let m=So(n,d,qt(p.dtype,"int32"));const g=N(f),v=n.data.get(m.dataId).values,y=n.data.get(p.dataId).values;for(let e=0;e<v.length;++e){const t=e*g;let n=0;for(let e=0;e<g;++e)n+=y[t+e];v[e]=n}if(r){const e=m;m=Wo({inputs:{x:m},backend:n,attrs:{shape:Ci(m.shape,c)}}),n.disposeIntermediateTensorInfo(e)}return n.disposeIntermediateTensorInfo(o),null!=u&&n.disposeIntermediateTensorInfo(p),m}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const qo={kernelName:at,backendName:"cpu",kernelFunc:function(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{reps:s}=a;yo(i,"tile");const r=function(e,t){const n=new Array(e.rank);for(let a=0;a<n.length;a++)n[a]=e.shape[a]*t[a];const a=Xa(n,e.dtype);for(let t=0;t<a.values.length;++t){const n=a.indexToLoc(t),i=new Array(e.rank);for(let t=0;t<i.length;t++)i[t]=n[t]%e.shape[t];const s=e.locToIndex(i);a.values[t]=e.values[s]}return a}(n.bufferSync(i),s);return n.makeTensorInfo(r.shape,r.dtype,r.values)}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Ho={kernelName:st,backendName:"cpu",kernelFunc:function(e){const{inputs:t,backend:n,attrs:a}=e,{value:i}=t;let{axis:s}=a;s<0&&(s+=i.shape.length);const r=i.shape.length,o=i.shape[s],l=new Array(r-1);let c=0;for(let e=0;e<r;e++)e!==s&&(l[c++]=i.shape[e]);const u=new Array(r).fill(0),h=i.shape.slice();h[s]=1;const p=new Array(o);for(let e=0;e<p.length;e++){u[s]=e;const t=Bo({inputs:{x:i},backend:n,attrs:{begin:u,size:h}});p[e]=Wo({inputs:{x:t},backend:n,attrs:{shape:l}}),n.disposeIntermediateTensorInfo(t)}return p}},Jo=_o(ge,(e=>e>=0?e:Math.exp(e)-1));
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const Zo=ko(((e,t)=>e<0?t*e:e));
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const Yo=_o(Le,(e=>Math.max(0,e))),Qo={kernelName:Le,backendName:"cpu",kernelFunc:Yo},Xo=_o(Be,(e=>Math.min(Math.max(0,e),6)));
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function el(e,t,n,a,i){if("linear"===n)return No({inputs:{x:t},backend:e});if("relu"===n)return Yo({inputs:{x:t},backend:e});if("elu"===n)return Jo({inputs:{x:t},backend:e});if("relu6"===n)return Xo({inputs:{x:t},backend:e});if("prelu"===n)return function(e){const{inputs:t,backend:n}=e,{x:a,alpha:i}=t;yo([a,i],"prelu");const s=n.data.get(a.dataId).values,r=n.data.get(i.dataId).values,[o,l]=Zo(a.shape,i.shape,s,r,"float32");return n.makeTensorInfo(l,"float32",o)}({inputs:{x:t,alpha:a},backend:e});if("leakyrelu"===n)
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
return function(e){const{inputs:t,backend:n,attrs:a}=e,{x:i}=t,{alpha:s}=a;yo([i],"leakyRelu");const r=N(i.shape),o=n.data.get(i.dataId).values,l=A("float32",r);for(let e=0;e<o.length;e++)l[e]=o[e]<0?s*o[e]:o[e];return n.makeTensorInfo(i.shape,"float32",l)}({inputs:{x:t},backend:e,attrs:{alpha:i}});if("sigmoid"===n)return Mo({inputs:{x:t},backend:e});throw new Error(`Activation ${n} has not been implemented for the CPU backend.`)}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const tl={kernelName:ct,backendName:"cpu",kernelFunc:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the License);
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an AS IS BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e){const{inputs:t,backend:n,attrs:a}=e,{a:i,b:s,bias:r,preluActivationWeights:o}=t,{transposeA:l,transposeB:c,activation:u,leakyreluAlpha:h}=a;let p,d,f;const m=[],g=function(e){const{inputs:t,backend:n,attrs:a}=e,{a:i,b:s}=t,{transposeA:r,transposeB:o}=a;yo([i,s],"matMul");const l=i.shape.length,c=s.shape.length,u=r?i.shape[l-2]:i.shape[l-1],h=o?s.shape[c-1]:s.shape[c-2],p=r?i.shape[l-1]:i.shape[l-2],d=o?s.shape[c-2]:s.shape[c-1],f=i.shape.slice(0,-2),m=s.shape.slice(0,-2),g=N(f),v=N(m),y=ma(i.shape.slice(0,-2),s.shape.slice(0,-2)).concat([p,d]);x(u===h,(()=>`Error in matMul: inner shapes (${u}) and (${h}) of Tensors with shapes ${i.shape} and ${s.shape} and transposeA=${r} and transposeB=${o} must match.`));const b=o?[v,d,h]:[v,h,d],w=Wo({inputs:{x:i},backend:n,attrs:{shape:r?[g,u,p]:[g,p,u]}}),k=Wo({inputs:{x:s},backend:n,attrs:{shape:b}}),S=r?w.shape[1]:w.shape[2],T=r?w.shape[2]:w.shape[1],I=o?k.shape[1]:k.shape[2],C=Math.max(g,v),$=n.data.get(w.dataId).values,A=n.data.get(k.dataId).values,E=R(w.shape),j=R(k.shape),[z,D,F]=r?[E[0],1,E[1]]:[E[0],E[1],1],[_,L,M]=o?[1,j[1],j[0]]:[j[1],1,j[0]],O=T*I,P=Xa([C,T,I],w.dtype),B=P.values,U=n.blockSize;for(let e=0;e<C;e++){const t=e%g,n=e%v;for(let a=0;a<T;a+=U){const i=Math.min(a+U,T);for(let s=0;s<I;s+=U){const r=Math.min(s+U,I);for(let o=0;o<S;o+=U){const l=Math.min(o+U,S);for(let c=a;c<i;c++)for(let a=s;a<r;a++){let i=0;for(let e=o;e<l;e++)i+=$[t*z+c*D+e*F]*A[e*_+a*L+n*M];B[e*O+(c*I+a)]+=i}}}}}return n.disposeIntermediateTensorInfo(w),n.disposeIntermediateTensorInfo(k),n.makeTensorInfo(y,P.dtype,P.values)}({inputs:{a:i,b:s},attrs:{transposeA:l,transposeB:c},backend:n});p=g,r&&(d=Eo({inputs:{a:p,b:r},backend:n}),m.push(p),p=d),u&&(f=el(n,p,u,o,h),m.push(p),p=f);for(const e of m)n.disposeIntermediateTensorInfo(e);return p}};
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */class nl extends Error{constructor(e){super(e),Object.setPrototypeOf(this,nl.prototype)}}class al extends Error{constructor(e){super(e),Object.setPrototypeOf(this,al.prototype)}}class il extends Error{constructor(e){super(e),Object.setPrototypeOf(this,il.prototype)}}class sl extends Error{constructor(e){super(e),Object.setPrototypeOf(this,sl.prototype)}}class rl extends Error{constructor(e){super(e),Object.setPrototypeOf(this,rl.prototype)}}
/**
     * @license
     * Copyright 2022 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */class ol{constructor(e){this.maxEntries=e||100,this.cache=new Map}get(e){let t;return this.cache.has(e)&&(t=this.cache.get(e),this.cache.delete(e),this.cache.set(e,t)),t}put(e,t){if(this.cache.has(e))this.cache.delete(e);else if(this.cache.size>=this.maxEntries){const e=this.cache.keys().next().value;this.cache.delete(e)}this.cache.set(e,t)}getMaxEntries(){return this.maxEntries}setMaxEntries(e){if(e<0)throw new Error(`The maxEntries of LRU caches must be at least 0, but got ${e}.`);if(this.maxEntries>e)for(let t=0;t<this.maxEntries-e;t++){const e=this.cache.keys().next().value;this.cache.delete(e)}this.maxEntries=e}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function ll(e,t){if(Array.isArray(e)){let n=[];for(let a=0;a<t;a++)n=n.concat(e);return n}{const n=new Array(t);return n.fill(e),n}}function cl(e,t){if(!e)throw new rl(t)}function ul(e,t){let n=0;for(const a of e)a===t&&n++;return n}function hl(e){return 1===e.length?e[0]:e}function pl(e){return Array.isArray(e)?e:[e]}function dl(e){const t=e.replace(/(.)([A-Z][a-z0-9]+)/g,"$1_$2").replace(/([a-z])([A-Z])/g,"$1_$2").toLowerCase();return"_"!==t[0]?t:"private"+t}function fl(e){return e.length<=1||-1===e.indexOf("_")?e:e.replace(/[_]+(\w|$)/g,((e,t)=>t.toUpperCase()))}let ml={};function gl(e){if(null==e)return null;const t={};return t.className=e.getClassName(),t.config=e.getConfig(),t}function vl(e){if(null!=e&&"object"==typeof e)if(Array.isArray(e))e.forEach((e=>vl(e)));else{const t=Object.keys(e);for(const n of t){const t=e[n];null!=t&&"object"==typeof t&&(Array.isArray(t)||"ndarray"!==t.type||"number"!=typeof t.value?vl(t):e[n]=t.value)}}}function yl(e,t={},n={},a="object",i=!1){if("string"==typeof e){const i=e;let s;if(i in n)s=n[i];else if(i in ml)s=ml[i];else if(s=t[i],null==s)throw new il(`Unknown ${a}: ${e}. This may be due to one of the following reasons:\n1. The ${a} is defined in Python, in which case it needs to be ported to TensorFlow.js or your JavaScript code.\n2. The custom ${a} is defined in JavaScript, but is not registered properly with tf.serialization.registerClass().`);return s}{const s=e;if(null==s.className||null==s.config)throw new il(`${a}: Improper config format: ${JSON.stringify(s)}.\n'className' and 'config' must set.`);const r=s.className;let o,l;if(r in n?[o,l]=n[r]:r in ml?[o,l]=ml.className:r in t&&([o,l]=t[r]),null==o)throw new il(`Unknown ${a}: ${r}. This may be due to one of the following reasons:\n1. The ${a} is defined in Python, in which case it needs to be ported to TensorFlow.js or your JavaScript code.\n2. The custom ${a} is defined in JavaScript, but is not registered properly with tf.serialization.registerClass().`);if(null!=l){const e={};for(const t of Object.keys(ml))e[t]=ml[t];for(const t of Object.keys(n))e[t]=n[t];s.config.customObjects=e;const t=Object.assign({},ml);for(const e of Object.keys(n))ml[e]=n[e];vl(s.config);const a=l(o,s.config,n,i);return ml=Object.assign({},t),a}{const e=Object.assign({},ml);for(const e of Object.keys(n))ml[e]=n[e];const t=new o(s.config);return ml=Object.assign({},e),t}}}function bl(e,t){return-1*function(e,t){return e<t?-1:e>t?1:0}(e,t)}function wl(e){if(null==e)return e;const t=[];for(const n of e)-1===t.indexOf(n)&&t.push(n);return t}function kl(e){if(null==e)throw new il(`Invalid value in obj: ${JSON.stringify(e)}`);for(const t in e)if(e.hasOwnProperty(t))return!1;return!0}function xl(e,t,n){if(null!=n&&e.indexOf(n)<0)throw new il(`${n} is not a valid ${t}.  Valid values are ${e} or null/undefined.`)}function Sl(e,t,n=0,a=1/0){return cl(n>=0),cl(a>=n),Array.isArray(e)&&e.length>=n&&e.length<=a&&e.every((e=>typeof e===t))}function Nl(e,t){Array.isArray(e)?(x(e.length>0,(()=>`${t} is unexpectedly an empty array.`)),e.forEach(((e,n)=>Nl(e,`element ${n+1} of ${t}`)))):x(Number.isInteger(e)&&e>0,(()=>`Expected ${t} to be a positive integer, but got ${Tl(e)}.`))}function Tl(e){return null===e?"null":Array.isArray(e)?"["+e.map((e=>Tl(e))).join(",")+"]":"string"==typeof e?`"${e}"`:`${e}`}function Il(e){return"relu"===e?"relu":"linear"===e?"linear":"elu"===e?"elu":null}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */let Cl=0;function $l(){return Cl++}const Al={};function El(e=""){return e in Al||(Al[e]=0),Al[e]+=1,e+Al[e].toString()}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */const jl=["channelsFirst","channelsLast"],zl=["nearest","bilinear"],Dl=["valid","same","causal"],Fl=["max","avg"],_l=["sum","mul","concat","ave"],Rl=new Map;function Ll(e){xl(jl,"DataFormat",e)}function Ml(e){xl(Dl,"PaddingMode",e)}function Ol(e){xl(Fl,"PoolMode",e)}const Pl=[];function Bl(e,t){Pl.push(e);try{const e=t();return Pl.pop(),e}catch(e){throw Pl.pop(),e}}function Ul(e){if(!Vl(e))throw new Error("Not a valid tensor name: '"+e+"'");return(0===Pl.length?"":Pl.join("/")+"/")+e}function Wl(e){if(!Vl(e))throw new Error("Not a valid tensor name: '"+e+"'");Rl.has(e)||Rl.set(e,0);const t=Rl.get(e);if(Rl.set(e,Rl.get(e)+1),t>0){const n=`${e}_${t}`;return Rl.set(n,1),n}return e}const Gl=new RegExp(/^[A-Za-z0-9][-A-Za-z0-9\._\/]*$/);function Vl(e){return!!e.match(Gl)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Kl(e,t,n){null==t&&(t=0),null==n&&(n=e.length);let a=1;for(let i=t;i<n;++i)a*=e[i];return a}function ql(e){if(0===e.length)return Number.NaN;let t=Number.POSITIVE_INFINITY;for(let n=0;n<e.length;n++){const a=e[n];a<t&&(t=a)}return t}function Hl(e){if(0===e.length)return Number.NaN;let t=Number.NEGATIVE_INFINITY;for(let n=0;n<e.length;n++){const a=e[n];a>t&&(t=a)}return t}function Jl(e,t){if(t<e)throw new il(`end (${t}) < begin (${e}) is forbidden.`);const n=[];for(let a=e;a<t;++a)n.push(a);return n}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */let Zl;function Yl(){return null==Zl&&(Zl=an.backend.epsilon()),Zl}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function Ql(e,t){return ra(e,t)}function Xl(e,t=-1){const n=e.shape.slice();return t<0&&(t=n.length+t+1),n.splice(t,0,1),Ma(e,n)}function ec(e,t,n){return wn((()=>{switch(e.rank){case 1:return ar(e,t,n);case 2:return ir(e,[t,0],[n,e.shape[1]]);case 3:return sr(e,[t,0,0],[n,e.shape[1],e.shape[2]]);case 4:return rr(e,[t,0,0,0],[n,e.shape[1],e.shape[2],e.shape[3]]);case 5:return Ga(e,[t,0,0,0,0],[n,e.shape[1],e.shape[2],e.shape[3],e.shape[4]]);case 6:return Ga(e,[t,0,0,0,0,0],[n,e.shape[1],e.shape[2],e.shape[3],e.shape[4],e.shape[5]]);default:throw new il(`sliceAlongFirstAxis() received an unsupported tensor rank: ${e.rank}`)}}))}function tc(e,t,n){return wn((()=>{switch(e.rank){case 1:return ar(e,t,n);case 2:return ir(e,[0,t],[e.shape[0],n]);case 3:return sr(e,[0,0,t],[e.shape[0],e.shape[1],n]);case 4:return rr(e,[0,0,0,t],[e.shape[0],e.shape[1],e.shape[2],n]);default:throw new il(`sliceAlongLastAxis() received an unsupported tensor rank: ${e.rank}`)}}))}function nc(e,t,n,a){return wn((()=>{switch(e.rank){case 1:return ar(e,t,n);case 2:switch(a){case 1:return ec(e,t,n);case 2:return tc(e,t,n);default:throw new il(`The axis is not within the rank of the tensor ${a}`)}case 3:switch(a){case 1:return ec(e,t,n);case 2:return sr(e,[0,t,0],[e.shape[0],n,e.shape[2]]);case 3:return tc(e,t,n);default:throw new il(`The axis is not within the rank of the tensor ${a}`)}case 4:switch(a){case 1:return ec(e,t,n);case 2:return rr(e,[0,t,0,0],[e.shape[0],n,e.shape[2],e.shape[3]]);case 3:return rr(e,[0,0,t,0],[e.shape[0],e.shape[1],n,e.shape[3]]);case 4:return tc(e,t,n);default:throw new il(`The axis is not within the rank of the tensor ${a}`)}default:throw new il(`sliceAlongLastAxis() received an unsupported tensor rank: ${e.rank}`)}}))}function ac(e,t=-1){let n;return t<0&&(n=e[0].rank,t=0!==n?n:0),t===e[0].rank&&(t=-1),Ua(e,t)}function ic(e,t){switch(e.rank){case 1:return ni([e,t]);case 2:return ai([e,t],0);case 3:return ii([e,t],0);case 4:return si([e,t],0);default:throw new il(`concatAlongFirstAxis() received an unsupported tensor rank: ${e.rank}`)}}function sc(e,t){if(Array.isArray(t)||(t=[t]),e.rank!==t.length)throw new il(`The length of input n (${t.length}) does not match the number of dimensions in input x (${e.rank})`);return Bi(e,t)}function rc(e,t=0,n=1,a,i){return Vs(e,t,n,a,i)}function oc(e,t,n,a){if(e.rank<2||t.rank<2)throw new sl(`dot requires both inputs to be rank >= 2 but got x shape = ${e.shape} and y shape = ${t.shape}`);if(t.rank>=3){if(e.shape.slice(-1)[0]!==t.shape.slice(-2)[0])throw new sl(`If rank y >= 3, then the second last dim of y must equal the last dim of x but got x shape = ${e.shape} and  y shape = ${t.shape}`)}if(2===e.rank&&2===t.rank){return Ir({a:e,b:t,transposeA:!1,transposeB:!1,bias:a?uc(e.rank,a,"channelsLast"):null,activation:n})}{const i=e.shape.slice(),s=i.pop();e=Ma(e,[-1,s]);const r=t.shape.slice(),o=r.pop(),l=r.pop(),c=[...r,o],u=Array.from({length:t.rank},((e,n)=>0===n?t.rank-2:n<=t.rank-2?n-1:n));t=Ma(pa(t,u),[l,-1]);const h=[...i,...c];return Ma(Ir({a:e,b:t,transposeA:!1,transposeB:!1,bias:a?uc(e.rank,a,"channelsLast"):null,activation:n}),h)}}function lc(e,t,n){return wn((()=>(t=Array.isArray(t)?pr(t,"int32"):ra(t,"int32"),Gi(e,t,n))))}function cc(e){return Ta(e,e)}function uc(e,t,n){const a=t.shape;if(1!==t.rank&&t.rank!==e)throw new il(`Unexpected bias dimensions: ${t.rank}; expected it to be 1 or ${e}`);if(5===e){if("channelsFirst"===n)return 1===a.length?Ma(t,[1,a[0],1,1,1]):Ma(t,[1,a[3],a[0],a[1],a[2]]);if("channelsLast"===n)return 1===a.length?Ma(t,[1,1,1,1,a[0]]):Ma(t,[1].concat(a))}else if(4===e){if("channelsFirst"===n)return 1===a.length?Ma(t,[1,a[0],1,1]):Ma(t,[1,a[2],a[0],a[1]]);if("channelsLast"===n)return 1===a.length?Ma(t,[1,1,1,a[0]]):Ma(t,[1].concat(a))}else if(3===e){if("channelsFirst"===n)return 1===a.length?Ma(t,[1,a[0],1]):Ma(t,[1,a[1],a[0]]);if("channelsLast"===n)return 1===a.length?Ma(t,[1,1,a[0]]):Ma(t,[1].concat(a))}else if(e<3)return t;throw new il(`Unsupported input rank by biasAdd: ${t.rank}`)}function hc(e,t,n){return wn((()=>(null==n&&(n="channelsLast"),Ll(n),xa(e,uc(e.rank,t,n)))))}function pc(e,t,n,a){return wn((()=>vr(e,t,n,a)))}function dc(e,t,n=!1){return n?e():t()}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */const fc=["fanIn","fanOut","fanAvg"],mc=["normal","uniform","truncatedNormal"];class gc extends ba{fromConfigUsesCustomObjects(){return!1}getConfig(){return{}}}class vc extends gc{apply(e,t){return cs(e,t)}}vc.className="Zeros",ka(vc);class yc extends gc{apply(e,t){return us(e,t)}}yc.className="Ones",ka(yc);class bc extends gc{constructor(e){if(super(),"object"!=typeof e)throw new il(`Expected argument of type ConstantConfig but got ${e}`);if(void 0===e.value)throw new il(`config must have value set but got ${e}`);this.value=e.value}apply(e,t){return wn((()=>Ta(Di(this.value),us(e,t))))}getConfig(){return{value:this.value}}}bc.className="Constant",ka(bc);class wc extends gc{constructor(e){super(),this.DEFAULT_MINVAL=-.05,this.DEFAULT_MAXVAL=.05,this.minval=e.minval||this.DEFAULT_MINVAL,this.maxval=e.maxval||this.DEFAULT_MAXVAL,this.seed=e.seed}apply(e,t){return Ks(e,this.minval,this.maxval,t,this.seed)}getConfig(){return{minval:this.minval,maxval:this.maxval,seed:this.seed}}}wc.className="RandomUniform",ka(wc);class kc extends gc{constructor(e){super(),this.DEFAULT_MEAN=0,this.DEFAULT_STDDEV=.05,this.mean=e.mean||this.DEFAULT_MEAN,this.stddev=e.stddev||this.DEFAULT_STDDEV,this.seed=e.seed}apply(e,t){if("float32"!==(t=t||"float32")&&"int32"!==t)throw new sl(`randomNormal does not support dType ${t}.`);return rc(e,this.mean,this.stddev,t,this.seed)}getConfig(){return{mean:this.mean,stddev:this.stddev,seed:this.seed}}}kc.className="RandomNormal",ka(kc);class xc extends gc{constructor(e){super(),this.DEFAULT_MEAN=0,this.DEFAULT_STDDEV=.05,this.mean=e.mean||this.DEFAULT_MEAN,this.stddev=e.stddev||this.DEFAULT_STDDEV,this.seed=e.seed}apply(e,t){if("float32"!==(t=t||"float32")&&"int32"!==t)throw new sl(`truncatedNormal does not support dType ${t}.`);return fr(e,this.mean,this.stddev,t,this.seed)}getConfig(){return{mean:this.mean,stddev:this.stddev,seed:this.seed}}}xc.className="TruncatedNormal",ka(xc);class Sc extends gc{constructor(e){super(),this.gain=null!=e.gain?e.gain:1}apply(e,t){return wn((()=>{if(2!==e.length||e[0]!==e[1])throw new il("Identity matrix initializer can only be used for 2D square matrices.");return Ta(this.gain,Ui(e[0]))}))}getConfig(){return{gain:this.gain}}}Sc.className="Identity",ka(Sc);class Nc extends gc{constructor(e){if(super(),e.scale<0)throw new il(`scale must be a positive float. Got: ${e.scale}`);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
var t;this.scale=null==e.scale?1:e.scale,this.mode=null==e.mode?"fanIn":e.mode,t=this.mode,xl(fc,"FanMode",t),this.distribution=null==e.distribution?"normal":e.distribution,function(e){xl(mc,"Distribution",e)}(this.distribution),this.seed=e.seed}apply(e,t){const n=function(e,t="channelsLast"){let n,a;if(Ll(t),2===e.length)n=e[0],a=e[1];else if(-1!==[3,4,5].indexOf(e.length)){if("channelsFirst"===t){const t=Kl(e,2);n=e[1]*t,a=e[0]*t}else if("channelsLast"===t){const t=Kl(e,0,e.length-2);n=e[e.length-2]*t,a=e[e.length-1]*t}}else{const t=Kl(e);n=Math.sqrt(t),a=Math.sqrt(t)}return[n,a]}(e),a=n[0],i=n[1];let s=this.scale;if("fanIn"===this.mode?s/=Math.max(1,a):"fanOut"===this.mode?s/=Math.max(1,i):s/=Math.max(1,(a+i)/2),"normal"===this.distribution){const n=Math.sqrt(s);if("float32"!==(t=t||"float32")&&"int32"!==t)throw new sl(`${this.getClassName()} does not support dType ${t}.`);return fr(e,0,n,t,this.seed)}{const n=Math.sqrt(3*s);return Ks(e,-n,n,t,this.seed)}}getConfig(){return{scale:this.scale,mode:this.mode,distribution:this.distribution,seed:this.seed}}}Nc.className="VarianceScaling",ka(Nc);class Tc extends Nc{constructor(e){super({scale:1,mode:"fanAvg",distribution:"uniform",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}Tc.className="GlorotUniform",ka(Tc);class Ic extends Nc{constructor(e){super({scale:1,mode:"fanAvg",distribution:"normal",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}Ic.className="GlorotNormal",ka(Ic);class Cc extends Nc{constructor(e){super({scale:2,mode:"fanIn",distribution:"normal",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}Cc.className="HeNormal",ka(Cc);class $c extends Nc{constructor(e){super({scale:2,mode:"fanIn",distribution:"uniform",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}$c.className="HeUniform",ka($c);class Ac extends Nc{constructor(e){super({scale:1,mode:"fanIn",distribution:"normal",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}Ac.className="LeCunNormal",ka(Ac);class Ec extends Nc{constructor(e){super({scale:1,mode:"fanIn",distribution:"uniform",seed:null==e?null:e.seed})}getClassName(){return Nc.className}}Ec.className="LeCunUniform",ka(Ec);class jc extends gc{constructor(e){super(),this.DEFAULT_GAIN=1,this.ELEMENTS_WARN_SLOW=2e3,this.gain=null==e.gain?this.DEFAULT_GAIN:e.gain,this.seed=e.seed}apply(e,t){return wn((()=>{if(e.length<2)throw new sl("Shape must be at least 2D.");if("int32"!==t&&"float32"!==t&&void 0!==t)throw new TypeError(`Unsupported data type ${t}.`);const n=N(e.slice(0,-1)),a=e[e.length-1],i=n*a;i>this.ELEMENTS_WARN_SLOW&&console.warn(`Orthogonal initializer is being called on a matrix with more than ${this.ELEMENTS_WARN_SLOW} (${i}) elements: Slowness may result.`);const s=rc([Math.max(a,n),Math.min(a,n)],0,1,t,this.seed),r=Yr.qr(s,!1);let o=r[0];const l=r[1].flatten().stridedSlice([0],[Math.min(a,n)*Math.min(a,n)],[Math.min(a,n)+1]);return o=Ta(o,l.sign()),n<a&&(o=o.transpose()),Ta(Di(this.gain),o.reshape(e))}))}getConfig(){return{gain:this.gain,seed:this.seed}}}jc.className="Orthogonal",ka(jc);const zc={constant:"Constant",glorotNormal:"GlorotNormal",glorotUniform:"GlorotUniform",heNormal:"HeNormal",heUniform:"HeUniform",identity:"Identity",leCunNormal:"LeCunNormal",leCunUniform:"LeCunUniform",ones:"Ones",orthogonal:"Orthogonal",randomNormal:"RandomNormal",randomUniform:"RandomUniform",truncatedNormal:"TruncatedNormal",varianceScaling:"VarianceScaling",zeros:"Zeros"};function Dc(e,t={}){return yl(e,wa.getMap().classNameMap,t,"initializer")}function Fc(e){return gl(e)}function _c(e){if("string"==typeof e){const t=e in zc?zc[e]:e;if("GlorotNormal"===t)return new Ic;if("GlorotUniform"===t)return new Tc;if("HeNormal"===t)return new Cc;if("HeUniform"===t)return new $c;if("LeCunNormal"===t)return new Ac;if("LeCunUniform"===t)return new Ec;{const e={};return e.className=t,e.config={},Dc(e)}}return e instanceof gc?e:Dc(e)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Rc(e){return Array.isArray(e)&&Array.isArray(e[0])}function Lc(e){return 0===e.length?[]:Array.isArray(e[0])?e:[e]}function Mc(e){let t;if(Array.isArray(e)){if(1!==e.length)throw new il(`Expected Tensor length to be 1; got ${e.length}`);t=e[0]}else t=e;return t}function Oc(e){if(Array.isArray(e)&&Array.isArray(e[0])){if(1===e.length)return e[0];throw new il(`Expected exactly 1 Shape; got ${e.length}`)}return e}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Pc(e){let t=0;for(const n of e)0===n.shape.length?t+=1:t+=n.shape.reduce(((e,t)=>e*t));return t}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */const Bc="Variable";class Uc{constructor(e,t="float32",n=Bc,a=!0,i=null){this.dtype=null==t?"float32":t,this.shape=e.shape,this.id=$l(),n=null==n?Bc:n,this.originalName=Ul(n),this.name=Wl(this.originalName),this.trainable_=a,this.constraint=i,this.val=function(e,t=!0,n,a){return an.makeVariable(e,t,n,a)}(e,this.trainable_,this.name,this.dtype)}read(){return this.assertNotDisposed(),this.val}write(e){return this.assertNotDisposed(),function(e,t){if(e.shape.toString()!==t.shape.toString())throw new Error("Shape mismatch: "+JSON.stringify(e.shape)+" vs. "+JSON.stringify(t.shape))}(this.val,e),this.val.id!==e.id&&(this.val.assign(e),null!=this.constraint&&this.val.assign(this.constraint.apply(this.val))),this}dispose(){this.assertNotDisposed(),this.val.dispose()}assertNotDisposed(){if(this.val.isDisposed)throw new Error(`LayersVariable ${this.name} is already disposed.`)}get trainable(){return this.trainable_}set trainable(e){this.trainable_=e,this.val.trainable=e}}function Wc(e){return e.map((e=>e.read()))}function Gc(e){e.forEach((e=>{e[0].write(e[1])}))}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */class Vc{constructor(e){this.dtype=e.dtype,this.shape=e.shape,null!=e.shape?this.ndim=e.shape.length:this.ndim=e.ndim,this.maxNDim=e.maxNDim,this.minNDim=e.minNDim,this.axes=e.axes||{}}}class Kc{constructor(e,t,n,a,i,s,r){this.dtype=e,this.shape=t,this.sourceLayer=n,this.inputs=a,this.callArgs=i,this.outputTensorIndex=r,this.id=$l(),null!=s&&(this.originalName=Ul(s),this.name=Wl(this.originalName)),this.rank=t.length}}let qc=0;class Hc{constructor(e,t){this.callArgs=t,this.id=qc++,this.outboundLayer=e.outboundLayer,this.inboundLayers=e.inboundLayers,this.nodeIndices=e.nodeIndices,this.tensorIndices=e.tensorIndices,this.inputTensors=e.inputTensors,this.outputTensors=e.outputTensors,this.inputMasks=e.inputMasks,this.outputMasks=e.outputMasks,this.inputShapes=e.inputShapes,this.outputShapes=e.outputShapes;for(const t of e.inboundLayers)null!=t&&t.outboundNodes.push(this);e.outboundLayer.inboundNodes.push(this)}getConfig(){const e=[];for(const t of this.inboundLayers)null!=t?e.push(t.name):e.push(null);return{outboundLayer:this.outboundLayer?this.outboundLayer.name:null,inboundLayers:e,nodeIndices:this.nodeIndices,tensorIndices:this.tensorIndices}}}let Jc=0;class Zc extends ba{constructor(e={}){super(),this._callHook=null,this._addedWeightNames=[],this._stateful=!1,this.id=Jc++,this.activityRegularizer=null,this.inputSpec=null,this.supportsMasking=!1,this._trainableWeights=[],this._nonTrainableWeights=[],this._losses=[],this._updates=[],this._built=!1,this.inboundNodes=[],this.outboundNodes=[];let t=e.name;if(!t){const e=this.getClassName();t=dl(e)+"_"+El(e)}if(this.name=t,this.trainable_=null==e.trainable||e.trainable,null!=e.inputShape||null!=e.batchInputShape){let t;if(null!=e.batchInputShape)t=e.batchInputShape;else if(null!=e.inputShape){let n=null;null!=e.batchSize&&(n=e.batchSize),t=[n].concat(e.inputShape)}this.batchInputShape=t;let n=e.dtype;null==n&&(n=e.inputDType),null==n&&(n="float32"),this.dtype=n}null!=e.weights?this.initialWeights=e.weights:this.initialWeights=null,this._refCount=null,this.fastWeightInitDuringBuild=!1}static nodeKey(e,t){return e.name+"_ib-"+t.toString()}getNodeAtIndex(e,t){if(0===this.inboundNodes.length)throw new al(`The layer has never been called and thus has no defined ${t}.`);if(this.inboundNodes.length<=e)throw new il(`Asked to get ${t} at node ${e}, but the layer has only ${this.inboundNodes.length} inbound nodes.`);return this.inboundNodes[e]}getInputAt(e){return hl(this.getNodeAtIndex(e,"input").inputTensors)}getOutputAt(e){return hl(this.getNodeAtIndex(e,"output").outputTensors)}get input(){if(this.inboundNodes.length>1)throw new nl(`Layer ${this.name} has multiple inbound nodes, hence the notion of "layer input" is ill-defined. Use \`getInputAt(nodeIndex)\` instead.`);if(0===this.inboundNodes.length)throw new nl(`Layer ${this.name} is not connected, no input to return.`);return hl(this.getNodeAtIndex(0,"input").inputTensors)}get output(){if(0===this.inboundNodes.length)throw new nl(`Layer ${this.name} has no inbound nodes.`);if(this.inboundNodes.length>1)throw new nl(`Layer ${this.name} has multiple inbound nodes, hence the notion of "layer output" is ill-defined. Use \`getOutputAt(nodeIndex)\` instead.`);return hl(this.getNodeAtIndex(0,"output").outputTensors)}get losses(){return this._losses}calculateLosses(){return this.losses.map((e=>e()))}get updates(){return this._updates}get built(){return this._built}set built(e){this._built=e}get trainable(){return this.trainable_}set trainable(e){this._trainableWeights.forEach((t=>t.trainable=e)),this.trainable_=e}get trainableWeights(){return this.trainable_?this._trainableWeights.filter((e=>e.trainable)):[]}set trainableWeights(e){this._trainableWeights=e}get nonTrainableWeights(){return this.trainable?this._trainableWeights.filter((e=>!e.trainable)).concat(this._nonTrainableWeights):this._trainableWeights.concat(this._nonTrainableWeights)}set nonTrainableWeights(e){this._nonTrainableWeights=e}get weights(){return this.trainableWeights.concat(this.nonTrainableWeights)}get stateful(){return this._stateful}resetStates(){if(!this.stateful)throw new Error("Cannot call the resetStates() method of a non-stateful Layer object.")}assertInputCompatibility(e){const t=pl(e);if(null==this.inputSpec||0===this.inputSpec.length)return;const n=pl(this.inputSpec);if(t.length!==n.length)throw new il(`Layer ${this.name} expects ${n.length} inputs, but it received ${t.length} input tensors. Input received: ${e}`);for(let e=0;e<t.length;e++){const a=t[e],i=n[e];if(null==i)continue;const s=a.rank;if(null!=i.ndim&&s!==i.ndim)throw new il(`Input ${e} is incompatible with layer ${this.name}: expected ndim=${i.ndim}, found ndim=${s}`);if(null!=i.maxNDim&&s>i.maxNDim)throw new il(`Input ${e} is incompatible with layer ${this.name}: expected max_ndim=${i.maxNDim}, found ndim=${s}`);if(null!=i.minNDim&&s<i.minNDim)throw new il(`Input ${e} is incompatible with layer ${this.name}: expected min_ndim=${i.minNDim}, found ndim=${s}.`);if(null!=i.dtype&&a.dtype!==i.dtype)throw new il(`Input ${e} is incompatible with layer ${this.name} : expected dtype=${i.dtype}, found dtype=${a.dtype}.`);if(i.axes){const t=a.shape;for(const n in i.axes){const a=Number(n),s=i.axes[n],r=a>=0?t[a]:t[t.length+a];if(null!=s&&-1===[s,null].indexOf(r))throw new il(`Input ${e} is incompatible with layer ${this.name}: expected axis ${a} of input shape to have value ${s} but got shape ${t}.`)}}if(null!=i.shape)for(let t=0;t<i.shape.length;++t){const n=i.shape[t],s=a.shape[t];if(null!=n&&null!=s&&n!==s)throw new il(`Input ${e} is incompatible with layer ${this.name}: expected shape=${i.shape}, found shape=${a.shape}.`)}}}call(e,t){return e}invokeCallHook(e,t){null!=this._callHook&&this._callHook(e,t)}setCallHook(e){this._callHook=e}clearCallHook(){this._callHook=null}apply(e,t){t=t||{},this.assertNotDisposed();const n=pl(e),a=function(e){let t=!0;for(const n of pl(e))if(!(n instanceof Kc)){t=!1;break}return t}(e),i=function(e){let t=!0;for(const n of pl(e))if(n instanceof Kc){t=!1;break}return t}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */(e);if(a===i)throw new il("Arguments to apply() must be all SymbolicTensors or all Tensors");return Bl(this.name,(()=>{if(!this.built){this.assertInputCompatibility(e);const t=[];for(const n of pl(e))t.push(n.shape);this.build(hl(t)),this.built=!0,this.initialWeights&&this.setWeights(this.initialWeights),null===this._refCount&&i&&(this._refCount=1)}if(this.assertInputCompatibility(e),i){let a=this.call(e,t);this.supportsMasking&&this.setMaskMetadata(e,a);const i=pl(a),s=[];for(let e of i)-1!==n.indexOf(e)&&(e=e.clone()),s.push(e);if(a=hl(s),null!=this.activityRegularizer)throw new sl("Layer invocation in the presence of activity regularizer(s) is not supported yet.");return a}{const n=function(e){e=pl(e);const t=[];for(const n of e)t.push(n.shape);return hl(t)}(e),a=this.computeOutputShape(n);let i;const s="float32";if(this.warnOnIncompatibleInputShape(Array.isArray(e)?n[0]:n),i=null!=a&&a.length>0&&Array.isArray(a[0])?a.map(((n,a)=>new Kc(s,n,this,pl(e),t,this.name,a))):new Kc(s,a,this,pl(e),t,this.name),this.addInboundNode(e,i,null,null,n,a,t),this._refCount++,null!=this.activityRegularizer)throw new sl("Layer invocation in the presence of activity regularizer(s) is not supported yet.");return i}}))}warnOnIncompatibleInputShape(e){if(null!=this.batchInputShape)if(e.length!==this.batchInputShape.length)console.warn(`The rank of the input tensor provided (shape: ${JSON.stringify(e)}) does not match that of the batchInputShape (${JSON.stringify(this.batchInputShape)}) of the layer ${this.name}`);else{let t=!1;this.batchInputShape.forEach(((n,a)=>{null!=n&&null!=e[a]&&e[a]!==n&&(t=!0)})),t&&console.warn(`The shape of the input tensor (${JSON.stringify(e)}) does not match the expectation of layer ${this.name}: ${JSON.stringify(this.batchInputShape)}`)}}get outputShape(){if(null==this.inboundNodes||0===this.inboundNodes.length)throw new nl(`The layer ${this.name} has never been called and thus has no defined output shape.`);const e=[];for(const t of this.inboundNodes){const n=JSON.stringify(t.outputShapes);-1===e.indexOf(n)&&e.push(n)}if(1===e.length){const e=this.inboundNodes[0].outputShapes;return Array.isArray(e)&&Array.isArray(e[0])&&1===e.length?e[0]:e}throw new nl(`The layer ${this.name} has multiple inbound nodes with different output shapes. Hence the notion of "output shape" is ill-defined for the layer.`)}countParams(){if(!this.built)throw new al(`You tried to call countParams() on ${this.name}, but the layer is not built yet. Build it first by calling build(batchInputShape).`);return Pc(this.weights)}build(e){this.built=!0}getWeights(e=!1){return Wc(e?this.trainableWeights:this.weights)}setWeights(e){wn((()=>{const t=this.weights;if(t.length!==e.length)throw new il(`You called setWeights(weights) on layer "${this.name}" with a weight list of length ${e.length}, but the layer was expecting ${t.length} weights. Provided weights: ${e}...`);if(0===t.length)return;const n=[],a=Wc(t);for(let i=0;i<a.length;++i){const s=a[i],r=t[i],o=e[i];if(!T(s.shape,o.shape))throw new il(`Layer weight shape ${s.shape} not compatible with provided weight shape ${o.shape}`);n.push([r,o])}Gc(n)}))}addWeight(e,t,n,a,i,s,r,o){if(-1!==this._addedWeightNames.indexOf(e))throw new il(`Duplicate weight name ${e} for layer ${this.name}`);this._addedWeightNames.push(e),null==n&&(n="float32"),this.fastWeightInitDuringBuild&&(a=null!=o?o():_c("zeros"));const l=a.apply(t,n),c=new Uc(l,n,e,s,r);return l.dispose(),null!=i&&this.addLoss((()=>i.apply(c.read()))),null==s&&(s=!0),s?this._trainableWeights.push(c):this._nonTrainableWeights.push(c),c}setFastWeightInitDuringBuild(e){this.fastWeightInitDuringBuild=e}addLoss(e){null==e||Array.isArray(e)&&0===e.length||(e=pl(e),void 0!==this._losses&&null!==this._losses&&this.losses.push(...e))}computeOutputShape(e){return e}computeMask(e,t){if(!this.supportsMasking){if(null!=t){if(!Array.isArray(t))throw new TypeError(`Layer ${this.name} does not support masking, but was passed an inputMask.`);t.forEach((e=>{if(null!=e)throw new TypeError(`Layer ${this.name} does not support masking, but was passed an inputMask.`)}))}return null}return t}setMaskMetadata(e,t,n){if(!this.supportsMasking)return;const a=this.computeMask(e,n),i=pl(t),s=pl(a);if(i.length!==s.length)throw new Error(`${this.name} outputs ${i.length} tensors but ${i.length} masks for those tensors`);for(let e=0;e<i.length;e++)i[e].kerasMask=s[e]}addInboundNode(e,t,n,a,i,s,r=null){const o=pl(e);t=pl(t),n=pl(n),a=pl(a),i=Lc(i),s=Lc(s);const l=[],c=[],u=[];for(const e of o)l.push(e.sourceLayer),c.push(e.nodeIndex),u.push(e.tensorIndex);new Hc({outboundLayer:this,inboundLayers:l,nodeIndices:c,tensorIndices:u,inputTensors:o,outputTensors:t,inputMasks:n,outputMasks:a,inputShapes:i,outputShapes:s},r);for(let e=0;e<t.length;e++)t[e].sourceLayer=this,t[e].nodeIndex=this.inboundNodes.length-1,t[e].tensorIndex=e}getConfig(){const e={name:this.name,trainable:this.trainable};return null!=this.batchInputShape&&(e.batchInputShape=this.batchInputShape),null!=this.dtype&&(e.dtype=this.dtype),e}disposeWeights(){return this.weights.forEach((e=>e.dispose())),this.weights.length}assertNotDisposed(){if(0===this._refCount)throw new Error(`Layer '${this.name}' is already disposed.`)}dispose(){if(!this.built)throw new Error(`Cannot dispose Layer ${this.name} because it has not been built yet.`);if(null===this._refCount)throw new Error(`Cannot dispose Layer ${this.name} because it has not been used yet.`);this.assertNotDisposed();let e=0;return 0==--this._refCount&&(e=this.disposeWeights()),{refCountAfterDispose:this._refCount,numDisposedVariables:e}}}function Yc(e,t,n){if((null==t||null!=n&&n>0)&&(t=e.sourceLayer,n=e.nodeIndex),0===t.inboundNodes.length)return[e];{const e=t.inboundNodes[n];if(0===e.inboundLayers.length)return e.inputTensors;{const t=[];for(let n=0;n<e.inboundLayers.length;n++){const a=Yc(e.inputTensors[n],e.inboundLayers[n],e.nodeIndices[n]);for(const e of a)-1===t.indexOf(e)&&t.push(e)}return t}}}class Qc extends Zc{constructor(e){if(super({dtype:e.dtype,name:null!=e.name?e.name:El("input").toString()}),null==e.batchSize&&(e.batchSize=null),null==e.sparse&&(e.sparse=!1),this.trainable=!1,this.built=!0,this.sparse=e.sparse,null!=e.inputShape&&null!=e.batchInputShape)throw new il("Only provide the inputShape OR batchInputShape argument to inputLayer, not both at the same time.");let t=e.batchInputShape;if(null==t){if(null==e.inputShape)throw new il("An InputLayer should be passed either a `batchInputShape` or an `inputShape`.");t=[e.batchSize].concat(e.inputShape)}else if(null!=e.batchSize)throw new il("Cannot specify batchSize if batchInputShape is specified when creating an InputLayer.");const n=e.dtype||"float32";this.batchInputShape=t,this.dtype=n,this.inputSpec=[{shape:t}];const a=new Kc(this.dtype,this.batchInputShape,this,[],{},this.name);a.nodeIndex=0,a.tensorIndex=0,new Hc({outboundLayer:this,inboundLayers:[],nodeIndices:[],tensorIndices:[],inputTensors:[a],outputTensors:[a],inputMasks:[null],outputMasks:[null],inputShapes:[t],outputShapes:[t]})}apply(e,t){throw new il(`Cannot pass any input to an InputLayer's apply() method. InputLayer name: ${this.name}`)}dispose(){return{refCountAfterDispose:this._refCount,numDisposedVariables:0}}getConfig(){return{batchInputShape:this.batchInputShape,dtype:this.dtype,sparse:this.sparse,name:this.name}}}Qc.className="InputLayer",ka(Qc);class Xc{constructor(e){if(this.id2Value={},this.id2Mask={},this.name2Id={},e instanceof Xc)for(const t in e.id2Value)this.id2Value[t]=e.id2Value[t],t in e.id2Mask&&(this.id2Mask[t]=e.id2Mask[t]);else{if(null==e)return;for(const t of e)this.add(t.key,t.value)}}add(e,t,n){if(null!=this.id2Value[e.id])throw new il(`Duplicate key: name=${e.name}, id=${e.id}`);return this.id2Value[e.id]=
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function(e,t){if(null==e.dtype||e.dtype===t.dtype)return t;try{return ra(t,e.dtype)}catch(n){throw new il(`The dtype of the feed (${t.dtype}) can not be cast to the dtype of the key '${e.name}' (${e.dtype}).`)}}(e,t),this.name2Id[e.name]=e.id,null!=n&&(this.id2Mask[e.id]=n),this}addFeed(e){this.add(e.key,e.value)}hasKey(e){return null!=this.id2Value[e.id]}names(){return Object.keys(this.name2Id)}getValue(e){if(e instanceof Kc){if(null==this.id2Value[e.id])throw new il(`Nonexistent key: ${e.name}`);return this.id2Value[e.id]}{const t=this.name2Id[e];if(null==t)throw new il(`Feed dict has no SymbolicTensor name: ${e}`);return this.id2Value[t]}}getMask(e){if(e instanceof Kc){if(null==this.id2Value[e.id])throw new il(`Nonexistent key: ${e.name}`);return this.id2Mask[e.id]}{const t=this.name2Id[e];if(null==t)throw new il(`Feed dict has no SymbolicTensor name: ${e}`);return this.id2Mask[t]}}disposeMasks(){null!=this.id2Mask&&kn(this.id2Mask)}}const eu=new ol,tu=new ol;function nu(e,t,n,a){const i=null!=n&&n.training,s=Array.isArray(e),r=s?e:[e],o=r.map((e=>e.name)),l=[],c=t.names();for(const e of o)-1!==c.indexOf(e)?l.push(t.getValue(e)):l.push(null);const u=o.join(",")+"|"+t.names().sort().join(",");let h,p=eu.get(u);if(null==p){const e=function(e,t){x(null!=e&&e.length>0,(()=>"Expected at least one fetch, got none"));let n=[],a={};if(1===e.length){const i=iu(e[0],t);n=i.sorted,a=i.recipientMap}else{const i=new Set;for(const s of e){const{sorted:e,recipientMap:r}=iu(s,t);for(const t of e)i.has(t.name)||(n.push(t),i.add(t.name));for(const e in r)null==a[e]&&(a[e]=new Set),r[e].forEach((t=>a[e].add(t)))}}return{sorted:n,recipientCounts:au(a)}}(r,t);p=e.sorted,h=e.recipientCounts,eu.put(u,p),tu.put(u,h)}h={},i||Object.assign(h,tu.get(u));const d=new Xc(t);for(let e=0;e<p.length;++e){const a=p[e],s=a.sourceLayer;if(s instanceof Qc)continue;const r=[],c=[],u=[];let f=!1;for(const e of a.inputs){const n=d.getValue(e),a=d.getMask(e);r.push(n),c.push(a),null!=a&&(f=!0),i||(h[e.name]--,0!==h[e.name]||t.hasKey(e)||-1!==o.indexOf(e.name)||n.isDisposed||!0===e.sourceLayer.stateful||u.push(n))}f&&((n=n||{}).mask=c[0]);const m=pl(s.apply(r,n));let g=null;s.supportsMasking&&(g=s.computeMask(r,c));const v=su(a),y=Array.isArray(v)?v:[v];for(let e=0;e<y.length;++e){d.hasKey(y[e])||d.add(y[e],m[e],Array.isArray(g)?g[0]:g);const t=o.indexOf(y[e].name);-1!==t&&(l[t]=m[e])}i||kn(u)}return d.disposeMasks(),s?l:l[0]}function au(e){const t={};for(const n in e)t[n]=e[n].size;return t}function iu(e,t){const n=new Set,a=[],i={};for(const e of t.names())n.add(e);const s=[],r=[];for(s.push(e);s.length>0;){const e=s[s.length-1];if(n.has(e.name)){s.pop();continue}const t=r[r.length-1]===s.length-1;if(0===e.inputs.length||t)s.pop(),a.push(e),n.add(e.name),t&&r.pop();else{r.push(s.length-1);for(const t of e.inputs)null==i[t.name]&&(i[t.name]=new Set),i[t.name].add(e.name),n.has(t.name)||s.push(t)}}return{sorted:a,recipientMap:i}}function su(e){let t;if(1===e.sourceLayer.inboundNodes.length)t=e.sourceLayer.output;else{let n=null;for(let t=0;t<e.sourceLayer.inboundNodes.length;++t)for(const a of e.sourceLayer.inboundNodes[t].outputTensors)if(a.id===e.id){n=t;break}t=e.sourceLayer.getOutputAt(n)}return t}
/**
     * @license
     * Copyright 2022 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */H().registerFlag("TOPOLOGICAL_SORT_CACHE_MAX_ENTRIES",(()=>100),(function(e){null!=eu&&eu.setMaxEntries(e),null!=tu&&tu.setMaxEntries(e)}));
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const ru={kernelName:"Abs",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,hr(ra(n,"float32"),-1))}}},ou={kernelName:"Acos",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>{const t=_i(ra(n,"float32")),a=Fi(es(Di(1),t));return ua(Na(e,a))}}}},lu={kernelName:"Acosh",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>{const t=Fi(es(_i(ra(n,"float32")),1));return Na(e,t)}}}},cu={kernelName:X,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{let t=e;const a=fa(n.shape,i);return a.length>0&&(t=Ri(t,a)),Ma(t,n.shape)},b:()=>{let t=e;const n=fa(a.shape,i);return n.length>0&&(t=Ri(t,n)),Ma(t,a.shape)}}}},uu={kernelName:"AddN",saveAllInputs:!0,gradFunc:(e,t)=>{const n={};return t.forEach(((t,a)=>{n[a]=()=>e.clone()})),n}},hu={kernelName:ee,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>ki(n)}}},pu={kernelName:"ArgMin",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>ki(n)}}},du={kernelName:"Asin",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,Fi(es(Di(1),_i(ra(n,"float32")))))}}},fu={kernelName:"Asinh",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>{const t=Fi(xa(Di(1),_i(ra(n,"float32"))));return Na(e,t)}}}},mu={kernelName:"Atan2",inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{const t=xa(_i(n),_i(a));let s=Ta(e,Na(a,t));const r=fa(n.shape,i);return r.length>0&&(s=Ri(s,r)),Ma(s,n.shape)},b:()=>{const t=xa(_i(n),_i(a));let s=ua(Ta(e,Na(n,t)));const r=fa(a.shape,i);return r.length>0&&(s=Ri(s,r)),Ma(s,a.shape)}}}},gu={kernelName:"Atan",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,xa(_i(ra(n,"float32")),1))}}},vu={kernelName:"Atanh",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,es(Di(1),_i(ra(n,"float32"))))}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const yu=pn({avgPool3dGrad_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i,s){const r=un(e,"dy","avgPool3dGrad"),o=un(t,"input","avgPool3dGrad");let l=r,c=o,u=!1;4===o.rank&&(u=!0,l=Ma(r,[1,r.shape[0],r.shape[1],r.shape[2],r.shape[3]]),c=Ma(o,[1,o.shape[0],o.shape[1],o.shape[2],o.shape[3]])),x(5===l.rank,(()=>`Error in avgPool3dGrad: dy must be rank 5 but got rank ${l.rank}.`)),x(5===c.rank,(()=>`Error in avgPool3dGrad: input must be rank 5 but got rank ${c.rank}.`)),La("avgPool3dGrad",i,s);const h={dy:l,input:c},p={filterSize:n,strides:a,pad:i,dimRoundingMode:s},d=an.runKernel("AvgPool3DGrad",h,p);return u?Ma(d,[d.shape[1],d.shape[2],d.shape[3],d.shape[4]]):d}}),bu={kernelName:ne,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{filterSize:i,strides:s,pad:r,dimRoundingMode:o}=n;return{x:()=>yu(e,a,i,s,r,o)}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const wu=pn({avgPoolGrad_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i){const s=un(e,"dy","avgPoolGrad"),r=un(t,"input","avgPoolGrad");x(r.rank===s.rank,(()=>`Rank of input (${r.rank}) does not match rank of dy (${s.rank})`));let o=r,l=s,c=!1;3===r.rank&&(c=!0,o=Ma(r,[1,r.shape[0],r.shape[1],r.shape[2]]),l=Ma(s,[1,s.shape[0],s.shape[1],s.shape[2]])),x(4===l.rank,(()=>`Error in avgPoolGrad: dy must be rank 4 but got rank ${l.rank}.`)),x(4===o.rank,(()=>`Error in avgPoolGrad: input must be rank 4 but got rank ${o.rank}.`));const u={dy:l,input:o},h={filterSize:n,strides:a,pad:i},p=an.runKernel("AvgPoolGrad",u,h);return c?Ma(p,[p.shape[1],p.shape[2],p.shape[3]]):p}}),ku={kernelName:te,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{filterSize:i,strides:s,pad:r}=n;return{x:()=>wu(e,a,i,s,r)}}},xu={kernelName:ae,inputsToSave:["a","b"],gradFunc:(e,t,n)=>{const[a,i]=t,{transposeA:s,transposeB:r}=n;return s||r?!s&&r?{a:()=>oa(e,i,!1,!1),b:()=>oa(e,a,!0,!1)}:s&&!r?{a:()=>oa(i,e,!1,!0),b:()=>oa(a,e,!1,!1)}:{a:()=>oa(i,e,!0,!0),b:()=>oa(e,a,!0,!0)}:{a:()=>oa(e,i,!1,!0),b:()=>oa(a,e,!0,!1)}}},Su={kernelName:ie,gradFunc:(e,t,n)=>{const{blockShape:a,crops:i}=n;return{x:()=>gs(e,a,i)}}},Nu={kernelName:"BroadcastTo",gradFunc:(e,t,n)=>{const a=n,i=a.inputShape,s=a.shape,r=Array.from(s);for(let e=i.length-1;e>=0;e--)if(i[e]===s[e])r[e]=1;else if(1!==i[e])throw new Error(`broadcastTo(): [${i}] cannot be broadcast to [${s}].`);const o=[];for(let e=0;e<r.length;e++)r[e]>1&&o.push(e);return{x:()=>Ri(e,o,!0)}}},Tu={kernelName:se,gradFunc:e=>({x:()=>e.clone()})},Iu={kernelName:"Ceil",gradFunc:e=>({x:()=>ki(e)})},Cu={kernelName:re,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{clipValueMin:i,clipValueMax:s}=n;return{x:()=>wi(as(Ki(a,i),Ji(a,s)),e,ki(e))}}},$u={kernelName:oe,inputsToSave:["x"],gradFunc:ru.gradFunc},Au={kernelName:le,saveAllInputs:!0,gradFunc:(e,t,n)=>{const a=t.map((e=>e.shape)),{axis:i}=n,s=$(i,t[0].shape)[0],r=a.map((e=>e[s]));return lr(e,r,s).map((e=>()=>e))}},Eu={kernelName:ce,inputsToSave:["x","filter"],gradFunc:(e,t,n)=>{const[a,i]=t,{dilations:s,strides:r,pad:o,dataFormat:l}=n;return x(Fa(s),(()=>`Error in gradient of conv2D: dilation rates greater than 1 are not yet supported in gradients. Got dilations '${s}'`)),{x:()=>li(a.shape,e,i,r,o,l),filter:()=>yr(a,e,i.shape,r,o,l)}}},ju={kernelName:ue,inputsToSave:["dy","filter"],gradFunc:(e,t,n)=>{const[a,i]=t,{strides:s,pad:r,dataFormat:o,dimRoundingMode:l}=n;return{dy:()=>ri(e,i,s,r,o,1,l),filter:()=>yr(e,a,i.shape,s,r,o,l)}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const zu=pn({conv3DBackpropFilter_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i){let s=e;4===e.rank&&(s=Ma(e,[1,e.shape[0],e.shape[1],e.shape[2],e.shape[3]]));let r=t;4===r.rank&&(r=Ma(t,[1,t.shape[0],t.shape[1],t.shape[2],t.shape[3]])),x(5===s.rank,(()=>`Error in conv3dDerFilter: input must be rank 5, but got shape ${s.shape}.`)),x(5===r.rank,(()=>`Error in conv3dDerFilter: dy must be rank 5, but got shape ${r.shape}.`)),x(5===n.length,(()=>`Error in conv3dDerFilter: filterShape must be length 5, but got ${n}.`)),x(s.shape[4]===n[3],(()=>`Error in conv3dDerFilter: depth of input ${s.shape[4]}) must match input depth in filter (${n[3]}.`)),x(r.shape[4]===n[4],(()=>`Error in conv3dDerFilter: depth of dy (${r.shape[4]}) must match output depth for filter (${n[4]}).`));const o={x:s,dy:r},l={strides:a,pad:i,filterShape:n};return an.runKernel("Conv3DBackpropFilterV2",o,l)}}),Du={kernelName:he,inputsToSave:["x","filter"],gradFunc:(e,t,n)=>{const{dilations:a,strides:i,pad:s}=n;x(Fa(a),(()=>`Error in gradient of conv3D: dilation rates greater than 1 are not yet supported in gradients. Got dilations '${a}'`));const[r,o]=t;return{x:()=>hi(r.shape,e,o,i,s),filter:()=>zu(r,e,o.shape,i,s)}}},Fu={kernelName:"Cos",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(ua(tr(ra(n,"float32"))),e)}}},_u={kernelName:pe,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(nr(ra(n,"float32")),e)}}},Ru={kernelName:de,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{axis:i,exclusive:s,reverse:r}=n;return{x:()=>{const t=$i([i],a.rank);let n=gi(e,i,s,!r);return null!=t&&(n=pa(n,t)),n}}}},Lu={kernelName:fe,inputsToSave:["x","filter"],gradFunc:(e,t,n)=>{const{dilations:a,strides:i,pad:s,dimRoundingMode:r}=n,o=null==a?[1,1]:a;x(Fa(o),(()=>`Error in gradient of depthwiseConv2dNative: dilation rates greater than 1 are not yet supported. Got dilations '${o}'`));const[l,c]=t;return x(4===l.rank,(()=>`Error in gradient of depthwiseConv2dNative: input must be rank 4, but got rank ${l.rank}.`)),x(4===c.rank,(()=>`Error in gradient of depthwiseConv2dNative: filter must be rank 4, but got rank ${c.rank}.`)),x(l.shape[3]===c.shape[2],(()=>`Error in gradient of depthwiseConv2d: number of input channels (${l.shape[3]}) must match the inChannels dimension in filter ${c.shape[2]}.`)),x(_a(i,o),(()=>`Error in gradient of depthwiseConv2d: Either strides or dilations must be  1. Got strides ${i} and dilations '${o}'.`)),La("depthwiseConv2d",s,r),{x:()=>Tr(l.shape,e,c,i,s,o,r),filter:()=>Nr(l,e,c.shape,i,s,o,r)}}},Mu={kernelName:"Dilation2D",inputsToSave:["x","filter"],gradFunc:(e,t,n)=>{const[a,i]=t,s={x:a,filter:i,dy:e},r={x:a,filter:i,dy:e};return{x:()=>an.runKernel("Dilation2DBackpropInput",s,n),filter:()=>an.runKernel("Dilation2DBackpropFilter",r,n)}}},Ou={kernelName:ge,outputsToSave:[!0],gradFunc:(e,t)=>{const[n]=t,a={dy:e,y:n};return{x:()=>an.runKernel("EluGrad",a)}}},Pu={kernelName:"Erf",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t,a=Ta(Oi(ua(_i(n))),2/Math.sqrt(Math.PI));return{x:()=>Ta(e,a)}}},Bu={kernelName:"Exp",outputsToSave:[!0],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,n)}}},Uu={kernelName:ve,inputsToSave:["input"],gradFunc:(e,t)=>{const[n]=t;return{input:()=>Ma(e,n.shape)}}},Wu={kernelName:"Expm1",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,Oi(n))}}},Gu={kernelName:ye,gradFunc:e=>({x:()=>ki(e)})},Vu={kernelName:be,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{const t=Na(e,ra(a,"float32")),s=fa(n.shape,i);return s.length>0?Ma(Ri(t,s),n.shape):t},b:()=>{let t=Ta(e,ra(n,"float32"));const s=fa(a.shape,i);s.length>0&&(t=Ma(Ri(t,s),a.shape));const r=_i(a);return ua(Na(t,ra(r,"float32")))}}}},Ku={kernelName:we,inputsToSave:["x","mean","variance","scale"],gradFunc:(e,t,n)=>{const{varianceEpsilon:a}=n,[i,s,r,o]=t,l=null==o?Di(1):o,c=fa(s.shape,i.shape),u=[];if(1===s.rank){for(let e=0;e<i.shape.length-1;++e)u.push(i.shape[e]);u.push(1)}const h=es(i,s),p=Ta(e,l),d=Qs(xa(r,Di(a))),f=Ta(Ta(Ta(d,d),d),Di(-.5));return{x:()=>1===s.rank?Ma(Ta(Ta(e,Bi(Ma(d,[1,1,1,s.shape[0]]),u)),l),i.shape):Ma(Ta(Ta(e,d),l),i.shape),mean:()=>{let e=Ta(Ta(d,Di(-1)),p);return 1===s.rank&&(e=Ri(e,c)),Ma(e,s.shape)},variance:()=>{let e=Ta(Ta(f,h),p);return 1===s.rank&&(e=Ri(e,c)),Ma(e,s.shape)},scale:()=>{const t=Ta(h,d);let n=Ta(e,t);return 1===s.rank&&(n=Ri(n,c)),Ma(n,s.shape)},offset:()=>{let t=e;return 1===s.rank&&(t=Ri(t,c)),Ma(t,s.shape)}}}},qu={kernelName:ke,inputsToSave:["x","indices"],gradFunc:(e,t,n)=>{const[a,i]=t,{axis:s,batchDims:r}=n,o=$(s,a.shape)[0],l=(e,t,n)=>()=>{const a=e.shape,i=t.size,r=a.slice(0,o),l=r.length,c=a.slice(s,a.length).slice(1),u=c.length,h=Hu(0,l),p=Hu(l+1,l+1+u),d=Ju([r,[i],c]),f=Ma(n,d),m=Ma(t,[i]),g=Ju([[l],h,p]),v=pa(f,g);let y=mr(v,m,e.shape[o]);const b=Ai(g);return y=pa(y,b),y};if(1===r){const t=a.shape[0],n=a.split(t,0);return{x:()=>{const t=ur(n.map(((t,n)=>l(t,i.slice(n,1),e.slice(n,1))())));return t.reshape(a.shape)},indices:()=>i}}return{x:l(a,i,e),indices:()=>i}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function Hu(e,t){const n=[];for(let a=e;a<t;++a)n.push(a);return n}function Ju(e){const t=[];for(let n=0;n<e.length;++n)for(let a=0;a<e[n].length;++a)t.push(e[n][a]);return t}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const Zu={kernelName:xe,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t;return{a:()=>ki(n),b:()=>ki(a)}}},Yu={kernelName:Se,gradFunc:e=>({x:()=>ra(e,"float32")})},Qu={kernelName:"IsFinite",gradFunc:e=>({x:()=>ki(e)})},Xu={kernelName:"IsInf",gradFunc:e=>({x:()=>ki(e)})},eh={kernelName:"IsNan",gradFunc:e=>({x:()=>ki(e)})},th={kernelName:Ne,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{alpha:i}=n,s=Vi(a,0);return{x:()=>wi(s,e,Ta(e,i))}}},nh={kernelName:Te,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,xa(n,1))}}},ah={kernelName:"Log",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,ra(n,"float32"))}}},ih={kernelName:"LogSoftmax",inputsToSave:[],outputsToSave:[!0],gradFunc:(e,t,n)=>{const[a]=t,{axis:i}=n;return{logits:()=>{const t=Oi(a);return es(e,Ta(Ri(e,i,!0),t))}}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const sh=pn({localResponseNormalizationBackprop_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a=5,i=1,s=1,r=.5){const o={x:e,y:t,dy:n},l={depthRadius:a,bias:i,alpha:s,beta:r};return an.runKernel("LRNGrad",o,l)}}),rh={kernelName:"LRN",inputsToSave:["x"],outputsToSave:[!0],gradFunc:(e,t,n)=>{const[a,i]=t,{depthRadius:s,bias:r,alpha:o,beta:l}=n;return{x:()=>sh(a,i,e,s,r,o,l)}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function oh(e,t,n,a){return t.rank<n.rank&&(t=Ma(t,Ci(t.shape,a))),e.rank<n.rank&&(e=Ma(e,Ci(e.shape,a))),{x:()=>Ta(e,ra(bi(n,t),e.dtype))}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const lh={kernelName:"Max",inputsToSave:["x"],outputsToSave:[!0],gradFunc:(e,t,n)=>{const a=n,{reductionIndices:i}=a,s=t[0],r=oh(e,t[1],s,$(i,s.shape));return{x:()=>r.x()}}},ch={kernelName:Ie,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t;return{a:()=>Ta(e,ra(Ki(n,a),"float32")),b:()=>Ta(e,ra(Hi(n,a),"float32"))}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const uh=pn({maxPool3dGrad_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i,s,r){const o=un(e,"dy","maxPool3dGrad"),l=un(t,"input","maxPool3dGrad"),c=un(n,"output","maxPool3dGrad");let u=o,h=l,p=c,d=!1;4===l.rank&&(d=!0,u=Ma(o,[1,o.shape[0],o.shape[1],o.shape[2],o.shape[3]]),h=Ma(l,[1,l.shape[0],l.shape[1],l.shape[2],l.shape[3]]),p=Ma(c,[1,c.shape[0],c.shape[1],c.shape[2],c.shape[3]])),x(5===u.rank,(()=>`Error in maxPool3dGrad: dy must be rank 5 but got rank ${u.rank}.`)),x(5===h.rank,(()=>`Error in maxPool3dGrad: input must be rank 5 but got rank ${h.rank}.`)),x(5===p.rank,(()=>`Error in maxPool3dGrad: output must be rank 5 but got rank ${p.rank}.`)),La("maxPool3dGrad",s,r);const f={dy:u,input:h,output:p},m={filterSize:a,strides:i,pad:s,dimRoundingMode:r},g=an.runKernel("MaxPool3DGrad",f,m);return d?Ma(g,[g.shape[1],g.shape[2],g.shape[3],g.shape[4]]):g}}),hh={kernelName:$e,inputsToSave:["x"],outputsToSave:[!0],gradFunc:(e,t,n)=>{const[a,i]=t,{filterSize:s,strides:r,pad:o,dimRoundingMode:l}=n;return{x:()=>uh(e,a,i,s,r,o,l)}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */const ph=pn({maxPoolGrad_:
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n,a,i,s,r){const o=un(e,"dy","maxPoolGrad"),l=un(t,"input","maxPoolGrad"),c=un(n,"output","maxPoolGrad");x(l.rank===o.rank,(()=>`Rank of input (${l.rank}) does not match rank of dy (${o.rank})`)),x(4===o.rank,(()=>`Error in maxPoolGrad: dy must be rank 4 but got rank ${o.rank}.`)),x(4===l.rank,(()=>`Error in maxPoolGrad: input must be rank 4 but got rank ${l.rank}.`)),La("maxPoolGrad",s,r);const u={dy:o,input:l,output:c},h={filterSize:a,strides:i,pad:s,dimRoundingMode:r};return an.runKernel("MaxPoolGrad",u,h)}}),dh={kernelName:Ce,inputsToSave:["x"],outputsToSave:[!0],gradFunc:(e,t,n)=>{const[a,i]=t,{filterSize:s,strides:r,pad:o}=n;return{x:()=>ph(e,a,i,s,r,o)}}},fh={kernelName:_e,inputsToSave:["x"],gradFunc:(e,t,n)=>{const a=t[0],{paddings:i}=n,s=i.map((e=>e[0]));return{x:()=>Ga(e,s,a.shape)}}},mh={kernelName:"Pow",inputsToSave:["a","b"],outputsToSave:[!0],gradFunc:(e,t)=>{const[n,a,i]=t,s=n,r=a,o=ma(s.shape,r.shape);return{a:()=>{const t=ra(r,"float32");let n=Ta(e,Ta(t,zi(s,es(t,Di(1)))));const a=fa(s.shape,o);return a.length>0&&(n=Ri(n,a)),Ma(n,s.shape)},b:()=>{const t=Vi(s,0),n=wi(t,Zi(s),ki(s));let a=Ta(e,Ta(i,n));const l=fa(r.shape,o);return l.length>0&&(a=Ri(a,l)),Ma(a,r.shape)}}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */function gh(e,t,n){const a=e.shape.length,i=a-n.length,s=$i(n,a);let r=e;null!=s&&(r=pa(e,s));const o=r.shape.slice(),l=o.splice(a-n.length,n.length).reduce(((e,t)=>e*t),1);o.push(l);let c=
/**
     * @license
     * Copyright 2022 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
function(e,t,n){const a=e.shape.slice();a[n]=1;const i=Ma(t,a),s=mi(e,n,!0,!1),r=mi(e,n,!0,!0),o=Ta(s,r);return Ta(i,o)}(r.reshape(o),t,i);if(c=c.reshape(r.shape),null!=s){const e=Ai(s);c=pa(c,e)}return c}const vh={kernelName:Xe,gradFunc:(e,t,n)=>{const{blockShape:a,paddings:i}=n;return{x:()=>Ka(e,a,i)}}},yh={kernelName:et,gradFunc:(e,t,n)=>{const{axis:a}=n;return{x:()=>Ua(e,a)}}};
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
const bh=[ru,ou,lu,cu,uu,hu,pu,du,fu,mu,gu,vu,bu,ku,xu,Su,Nu,Tu,Iu,Cu,$u,Au,ju,Eu,Du,Fu,_u,Ru,Lu,Mu,{kernelName:me,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{const t=Na(e,ra(a,"float32")),s=fa(n.shape,i);return s.length>0?Ma(Ri(t,s),n.shape):t},b:()=>{let t=Ta(e,ra(n,"float32"));const s=fa(a.shape,i);s.length>0&&(t=Ma(Ri(t,s),a.shape));const r=_i(a);return ua(Na(t,ra(r,"float32")))}}}},Ou,Pu,Bu,Uu,Wu,Vu,Gu,Ku,qu,Zu,Yu,Qu,Xu,eh,th,nh,ah,ih,rh,lh,lh,ch,hh,dh,{kernelName:Ae,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{axis:i}=n,s=$(i,a.shape),r=N(Ii(a.shape,s)[1]);return{x:()=>{const t=a.shape.slice();s.forEach((e=>{t[e]=1}));const n=Ma(e,t);return Na(Ta(n,us(a.shape,"float32")),r)}}}},{kernelName:"Min",inputsToSave:["x"],outputsToSave:[!0],gradFunc:(e,t,n)=>{const a=n,{axis:i}=a,[s,r]=t,o=oh(e,r,s,$(i,s.shape));return{x:()=>o.x()}}},{kernelName:Ee,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t;return{a:()=>Ta(e,ra(Ji(n,a),"float32")),b:()=>Ta(e,ra(Vi(n,a),"float32"))}}},{kernelName:"MirrorPad",inputsToSave:["x"],gradFunc:(e,t,n)=>{const a=t[0],{paddings:i}=n,s=i.map((e=>e[0]));return{x:()=>Ga(e,s,a.shape)}}},{kernelName:"Mod",inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{const t=fa(n.shape,i);return t.length>0?Ma(Ri(e,t),n.shape):e},b:()=>{const t=Ta(e,ua(Wi(Na(n,a)))),s=fa(a.shape,i);return s.length>0?Ma(Ri(t,s),a.shape):t}}}},{kernelName:je,inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{const t=Ta(e,ra(a,"float32")),s=fa(n.shape,i);return s.length>0?Ma(Ri(t,s),n.shape):t},b:()=>{const t=Ta(e,ra(n,"float32")),s=fa(a.shape,i);return s.length>0?Ma(Ri(t,s),a.shape):t}}}},{kernelName:"Neg",gradFunc:e=>({x:()=>ua(e)})},{kernelName:De,inputsToSave:["indices"],gradFunc:(e,t)=>{const n=t[0];return{indices:()=>cs(n.shape,"float32")}}},{kernelName:ze,gradFunc:e=>({x:()=>ki(e)})},{kernelName:Fe,saveAllInputs:!0,gradFunc:(e,t,n)=>{const{axis:a}=n;return gr(e,a).map((e=>()=>e))}},fh,fh,mh,{kernelName:Re,inputsToSave:["x","alpha"],gradFunc:(e,t)=>{const[n,a]=t,i=Vi(n,0);return{x:()=>wi(i,e,Ta(e,a)),alpha:()=>{let t=wi(i,ki(e),Ta(e,n));const s=fa(a.shape,e.shape);return s.length>0&&(t=Ri(t,s)),Ma(t,a.shape)}}}},{kernelName:"Prod",inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{axis:i}=n;let s=[];return s=null==i?a.shape.map(((e,t)=>t)):"number"==typeof i?[i]:i,{x:()=>gh(a,e,s)}}},{kernelName:"Reciprocal",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,ua(_i(n)))}}},{kernelName:Be,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t,a=Ta(Ji(n,6),hr(n));return{x:()=>Ta(e,ra(a,"float32"))}}},{kernelName:Le,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,ra(hr(n),"float32"))}}},{kernelName:Me,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ma(e,n.shape)}}},{kernelName:Pe,inputsToSave:["images"],gradFunc:(e,t,n)=>{const[a]=t,i={dy:e,images:a};return{images:()=>an.runKernel("ResizeBilinearGrad",i,n)}}},{kernelName:Oe,inputsToSave:["images"],gradFunc:(e,t,n)=>{const[a]=t,i={dy:e,images:a};return{images:()=>an.runKernel("ResizeNearestNeighborGrad",i,n)}}},{kernelName:Ue,gradFunc:(e,t,n)=>{const{dims:a}=n,i=$(a,e.shape);return{x:()=>Zs(e,i)}}},{kernelName:We,gradFunc:e=>({x:()=>ki(e)})},{kernelName:Ge,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>ua(Na(e,Ta(zi(n,1.5),2)))}}},{kernelName:Ve,inputsToSave:["condition"],gradFunc:(e,t)=>{const[n]=t;return{condition:()=>ra(ki(n),"float32"),t:()=>Ta(e,ra(n,e.dtype)),e:()=>Ta(e,ra(is(n),e.dtype))}}},{kernelName:Ke,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>{const t=Vi(n,Di(0)),a=Di(1.7580993408473768),i=Di(1.0507009873554805),s=Ta(e,i),r=Ta(Ta(e,a),Oi(ra(n,"float32")));return wi(t,s,r)}}}},{kernelName:Je,outputsToSave:[!0],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,Ta(n,es(Di(1),n)))}}},{kernelName:"Sign",gradFunc:e=>({x:()=>ki(e)})},{kernelName:"Sin",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(di(ra(n,"float32")),e)}}},{kernelName:He,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(fi(ra(n,"float32")),e)}}},{kernelName:qe,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{begin:i,size:s}=n,r=a.shape,[o,l]=ga(a,i,s),c=[];for(let t=0;t<e.rank;t++)c.push([o[t],r[t]-o[t]-l[t]]);return{x:()=>ms(e,c)}}},{kernelName:tt,outputsToSave:[!0],gradFunc:(e,t,n)=>{const[a]=t,{dim:i}=n,s=Ta(e,a);return{logits:()=>es(s,Ta(Ri(s,[i],true),a))}}},{kernelName:Ze,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,Wa(n))}}},vh,vh,yh,yh,{kernelName:Ye,inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,Ta(Fi(ra(n,"float32")),2))}}},{kernelName:"SquaredDifference",inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=Di(2);return{a:()=>Ta(e,Ta(i,es(n,a))),b:()=>Ta(e,Ta(i,es(a,n)))}}},{kernelName:"Square",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(e,Ta(ra(n,"float32"),2))}}},{kernelName:lt,gradFunc:e=>({x:()=>ki(e)})},{kernelName:"Sub",inputsToSave:["a","b"],gradFunc:(e,t)=>{const[n,a]=t,i=ma(n.shape,a.shape);return{a:()=>{let t=e;const a=fa(n.shape,i);return a.length>0&&(t=Ri(t,a)),Ma(t,n.shape)},b:()=>{let t=e;const n=fa(a.shape,i);return n.length>0&&(t=Ri(t,n)),Ma(ua(t),a.shape)}}}},{kernelName:Qe,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,i=a.shape.slice(),{axis:s}=n;$(s,a.shape).forEach((e=>{i[e]=1}));const r=Ma(e,i),o=Ta(r,us(a.shape,"float32"));return{x:()=>o}}},{kernelName:"Tan",inputsToSave:["x"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Na(e,_i(di(n)))}}},{kernelName:nt,outputsToSave:[!0],gradFunc:(e,t)=>{const[n]=t;return{x:()=>Ta(es(Di(1),_i(n)),e)}}},{kernelName:at,inputsToSave:["x"],gradFunc:(e,t,n)=>{const[a]=t,{reps:i}=n;return{x:()=>{let t=ki(a);if(1===a.rank)for(let n=0;n<i[0];++n)t=xa(t,Ga(e,[n*a.shape[0]],[a.shape[0]]));else if(2===a.rank)for(let n=0;n<i[0];++n)for(let s=0;s<i[1];++s)t=xa(t,Ga(e,[n*a.shape[0],s*a.shape[1]],[a.shape[0],a.shape[1]]));else if(3===a.rank)for(let n=0;n<i[0];++n)for(let s=0;s<i[1];++s)for(let r=0;r<i[2];++r)t=xa(t,Ga(e,[n*a.shape[0],s*a.shape[1],r*a.shape[2]],[a.shape[0],a.shape[1],a.shape[2]]));else{if(4!==a.rank)throw new Error(`Gradient for tile operation is not implemented for rank-${a.rank} tensors yet.`);for(let n=0;n<i[0];++n)for(let s=0;s<i[1];++s)for(let r=0;r<i[2];++r)for(let o=0;o<i[3];++o)t=xa(t,Ga(e,[n*a.shape[0],s*a.shape[1],r*a.shape[2],o*a.shape[3]],[a.shape[0],a.shape[1],a.shape[2],a.shape[3]]))}return t}}}},{kernelName:it,gradFunc:(e,t,n)=>{const a=n,{perm:i}=a,s=Ai(i);return{x:()=>pa(e,s)}}},{kernelName:st,gradFunc:(e,t,n)=>{const a=n,{axis:i}=a;return{value:()=>ur(e,i)}}},{kernelName:rt,inputsToSave:["segmentIds"],gradFunc:(e,t)=>{const[n]=t;return{x:()=>function(e,t){const n=os(t,ki(t)),a=Gi(e,n);let i=Ki(t,Di(0,"int32"));const s=a.rank-i.rank;for(let e=0;e<s;++e)i=Pi(i,e+1);i=as(i,us(a.shape,"bool"));const r=ki(a);return wi(i,a,r)}(e,n)}}},{kernelName:ot,gradFunc:e=>({x:()=>ki(e)})}];
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */for(const e of bh)yt(e);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function wh(e,t){return wn((()=>Fi(Ri(Ta(e,e),t,!0))))}class kh extends ba{getConfig(){return{}}}class xh extends kh{constructor(e){super(),this.defaultMaxValue=2,this.defaultAxis=0,this.maxValue=null!=e.maxValue?e.maxValue:this.defaultMaxValue,this.axis=null!=e.axis?e.axis:this.defaultAxis}apply(e){return wn((()=>{const t=wh(e,this.axis),n=ti(t,0,this.maxValue);return Ta(e,Na(n,xa(Yl(),t)))}))}getConfig(){return{maxValue:this.maxValue,axis:this.axis}}}xh.className="MaxNorm",ka(xh);class Sh extends kh{constructor(e){super(),this.defaultAxis=0,this.axis=null!=e.axis?e.axis:this.defaultAxis}apply(e){return wn((()=>Na(e,xa(Yl(),wh(e,this.axis)))))}getConfig(){return{axis:this.axis}}}Sh.className="UnitNorm",ka(Sh);class Nh extends kh{apply(e){return Hs(e)}}Nh.className="NonNeg",ka(Nh);class Th extends kh{constructor(e){super(),this.defaultMinValue=0,this.defaultMaxValue=1,this.defaultRate=1,this.defaultAxis=0,this.minValue=null!=e.minValue?e.minValue:this.defaultMinValue,this.maxValue=null!=e.maxValue?e.maxValue:this.defaultMaxValue,this.rate=null!=e.rate?e.rate:this.defaultRate,this.axis=null!=e.axis?e.axis:this.defaultAxis}apply(e){return wn((()=>{const t=wh(e,this.axis),n=xa(Ta(this.rate,ti(t,this.minValue,this.maxValue)),Ta(1-this.rate,t));return Ta(e,Na(n,xa(Yl(),t)))}))}getConfig(){return{minValue:this.minValue,maxValue:this.maxValue,rate:this.rate,axis:this.axis}}}Th.className="MinMaxNorm",ka(Th);const Ih={maxNorm:"MaxNorm",minMaxNorm:"MinMaxNorm",nonNeg:"NonNeg",unitNorm:"UnitNorm"};function Ch(e){return gl(e)}function $h(e,t={}){return yl(e,wa.getMap().classNameMap,t,"constraint")}function Ah(e){if(null==e)return null;if("string"==typeof e){return $h({className:e in Ih?Ih[e]:e,config:{}})}return e instanceof kh?e:$h(e)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */async function Eh(e){if(null==e)return;const t=[],n=[],a=[];for(const i in e){const s=e[i];if("number"!=typeof s){const e=s;t.push(e.data()),n.push(i),a.push(e)}}if(t.length>0){const i=await Promise.all(t);for(let t=0;t<i.length;++t)e[n[t]]=i[t][0];kn(a)}}function jh(e){if(null!=e)for(const t in e){const n=e[t];"number"!=typeof n&&n.dispose()}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */var zh;!function(e){e[e.SILENT=0]="SILENT",e[e.VERBOSE=1]="VERBOSE"}(zh||(zh={}));class Dh{constructor(){this.validationData=null}setParams(e){this.params=e}async onEpochBegin(e,t){}async onEpochEnd(e,t){}async onBatchBegin(e,t){}async onBatchEnd(e,t){}async onTrainBegin(e){}async onTrainEnd(e){}setModel(e){}}class Fh{constructor(e,t=10){null==e&&(e=[]),this.callbacks=e,this.queueLength=t}append(e){this.callbacks.push(e)}setParams(e){for(const t of this.callbacks)t.setParams(e)}setModel(e){for(const t of this.callbacks)t.setModel(e)}async onEpochBegin(e,t){null==t&&(t={});for(const n of this.callbacks)await n.onEpochBegin(e,t)}async onEpochEnd(e,t){null==t&&(t={});for(const n of this.callbacks)await n.onEpochEnd(e,t)}async onBatchBegin(e,t){null==t&&(t={});for(const n of this.callbacks)await n.onBatchBegin(e,t)}async onBatchEnd(e,t){null==t&&(t={});for(const n of this.callbacks)await n.onBatchEnd(e,t)}async onTrainBegin(e){null==e&&(e={});for(const t of this.callbacks)await t.onTrainBegin(e)}async onTrainEnd(e){null==e&&(e={});for(const t of this.callbacks)await t.onTrainEnd(e)}}class _h extends Dh{constructor(){super()}async onEpochBegin(e){this.seen=0,this.totals={}}async onBatchEnd(e,t){null==t&&(t={});const n=null==t.size?0:t.size;this.seen+=n;for(const e in t){const a=t[e];if("number"==typeof a)this.totals.hasOwnProperty(e)||(this.totals[e]=0),this.totals[e]=this.totals[e]+a*n;else{let t;e in this.totals?t=this.totals[e]:this.totals[e]=0;const i=wn((()=>xa(this.totals[e],Ta(a,n))));this.totals[e]=i,null!=t&&t.dispose()}}}async onEpochEnd(e,t){if(null!=t)for(const e of this.params.metrics)null!=this.totals[e]&&("number"==typeof this.totals[e]?t[e]=this.totals[e]/this.seen:wn((()=>{const n=Ta(Na(1,this.seen),this.totals[e]);t[e]=n,this.totals[e].dispose(),xn(t[e])})))}}class Rh extends Dh{async onTrainBegin(e){this.epoch=[],this.history={}}async onEpochEnd(e,t){null==t&&(t={}),this.epoch.push(e);for(const e in t)null==this.history[e]&&(this.history[e]=[]),this.history[e].push(t[e])}async syncData(){const e=[],t=[],n=[];for(const a in this.history){const i=this.history[a];for(let s=0;s<i.length;++s)if("number"!=typeof i[s]){const r=i[s];e.push(r.data()),t.push(a),n.push(s)}}const a=await Promise.all(e);for(let e=0;e<a.length;++e){this.history[t[e]][n[e]].dispose(),this.history[t[e]][n[e]]=a[e][0]}}}class Lh extends Dh{constructor(e,t){if(super(),this.currentEpoch=0,this.nowFunc=e.nowFunc,this.nextFrameFunc=e.nextFrameFunc||lo,this.yieldEvery=t||"auto","auto"===this.yieldEvery&&(this.yieldEvery=125),"never"===this.yieldEvery&&null!=e.onYield)throw new Error("yieldEvery is `never` but you provided an `onYield` callback. Either change `yieldEvery` or remove the callback");D(this.yieldEvery)&&(this.maybeWait=function(e,t,n){let a,i=null!=n?n():xt();return(...s)=>{const r=null!=n?n():xt();return r-i<t||(i=r,a=e(...s)),a}}(this.maybeWait.bind(this),this.yieldEvery,this.nowFunc)),this.trainBegin=e.onTrainBegin,this.trainEnd=e.onTrainEnd,this.epochBegin=e.onEpochBegin,this.epochEnd=e.onEpochEnd,this.batchBegin=e.onBatchBegin,this.batchEnd=e.onBatchEnd,this.yield=e.onYield}async maybeWait(e,t,n){const a=[];null!=this.yield&&(await Eh(n),a.push(this.yield(e,t,n))),a.push(this.nextFrameFunc()),await Promise.all(a)}async onEpochBegin(e,t){this.currentEpoch=e,null!=this.epochBegin&&(await Eh(t),await this.epochBegin(e,t))}async onEpochEnd(e,t){const n=[];null!=this.epochEnd&&(await Eh(t),n.push(this.epochEnd(e,t))),"epoch"===this.yieldEvery&&n.push(this.nextFrameFunc()),await Promise.all(n)}async onBatchBegin(e,t){null!=this.batchBegin&&(await Eh(t),await this.batchBegin(e,t))}async onBatchEnd(e,t){const n=[];null!=this.batchEnd&&(await Eh(t),n.push(this.batchEnd(e,t))),"batch"===this.yieldEvery?n.push(this.nextFrameFunc()):D(this.yieldEvery)&&n.push(this.maybeWait(this.currentEpoch,e,t)),await Promise.all(n)}async onTrainBegin(e){null!=this.trainBegin&&(await Eh(e),await this.trainBegin(e))}async onTrainEnd(e){null!=this.trainEnd&&(await Eh(e),await this.trainEnd(e))}}function Mh(e,t){if(null==e&&(e={}),e instanceof Dh)return[e];if(Array.isArray(e)&&e[0]instanceof Dh)return e;return pl(e).map((e=>new Lh(e,t)))}class Oh{constructor(){}static registerCallbackConstructor(e,t){x(e>=0&&Number.isInteger(e),(()=>`Verbosity level is expected to be an integer >= 0, but got ${e}`)),Oh.checkForDuplicate(t),null==Oh.constructors[e]&&(Oh.constructors[e]=[]),Oh.constructors[e].push(t)}static checkForDuplicate(e){for(const t in Oh.constructors){Oh.constructors[+t].forEach((t=>{if(t===e)throw new il("Duplicate callback constructor.")}))}}static clear(){Oh.constructors={}}static createCallbacks(e){const t=[];for(const n in Oh.constructors){const a=+n;e>=a&&t.push(...Oh.constructors[a])}return t.map((e=>new e))}}function Ph(e,t,n,a,i,s,r,o,l){const c=new Rh,u=[new _h,...Oh.createCallbacks(t)];null!=e&&u.push(...e),u.push(c);const h=new Fh(u);return h.setParams({epochs:n,initialEpoch:a,samples:i,steps:s,batchSize:r,verbose:t,doValidation:o,metrics:l}),{callbackList:h,history:c}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Bh(e,t={},n=!1){return yl(e,wa.getMap().classNameMap,t,"layer",n)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Uh(e,t){return wn((()=>{"float32"!==e.dtype&&(e=ra(e,"float32"));const n=Ri(cc(e),t,!0),a=ei(n.shape,Yl()),i=Fi(os(n,a));return Na(e,i)}))}function Wh(e,t){return wn((()=>ls(cc(es(t,e)),-1)))}function Gh(e,t){return wn((()=>ls(Ia(es(t,e)),-1)))}function Vh(e,t){return wn((()=>{const n=es(e,t),a=ti(Ia(e),Yl(),Number.MAX_VALUE),i=Ia(Na(n,a));return Ta(100,ls(i,-1))}))}function Kh(e,t,n=!1){return wn((()=>{if(n)t=or(t);else{const e=Ri(t,t.shape.length-1,!0);t=Na(t,e)}return t=ti(t,Yl(),1-Yl()),ua(Ri(Ta(ra(e,"float32"),Zi(t)),t.shape.length-1))}))}function qh(e,t,n=!1){return wn((()=>{const a=ra(Wi(function(e){const t=[Kl(e.shape)];return Ma(e,t)}(e)),"int32"),i=(t=ti(t,Yl(),1-Yl())).shape;return Kh(Ma(la(a,i[i.length-1]),i),t,n)}))}function Hh(e,t){return wn((()=>{let n;return n=ti(t,Yl(),1-Yl()),n=Zi(Na(n,es(1,n))),ls(function(e,t){if(!T(e.shape,t.shape))throw new il(`logits and labels must have the same shape, but got shapes ${JSON.stringify(e.shape)} and ${JSON.stringify(t.shape)}`);return wn((()=>{const n=Hs(t),a=ua(Ia(t));return xa(es(n,Ta(t,e)),Yi(Oi(a)))}))}(e,n),-1)}))}function Jh(e,t){return wn((()=>{const n=Uh(e,-1),a=Uh(t,-1),i=Ta(n,a);return ua(Ri(i,-1))}))}Oh.constructors={};const Zh={meanSquaredError:Wh,meanAbsoluteError:Gh,meanAbsolutePercentageError:Vh,meanSquaredLogarithmicError:function(e,t){return wn((()=>{const n=ti(t,Yl(),Number.MAX_VALUE),a=Zi(xa(1,n)),i=ti(e,Yl(),Number.MAX_VALUE),s=Zi(xa(1,i));return ls(cc(es(a,s)),-1)}))},squaredHinge:function(e,t){return wn((()=>{const n=os(0,es(1,Ta(e,t)));return ls(cc(n),-1)}))},hinge:function(e,t){return wn((()=>{const n=os(0,es(1,Ta(e,t)));return ls(n,-1)}))},categoricalHinge:function(e,t){return wn((()=>{const n=Ri(Ta(e,t),-1),a=Ei(Ta(es(1,e),t),-1);return os(0,xa(1,es(a,n)))}))},logcosh:function(e,t){return wn((()=>{const n=Math.log(2),a=es(t,e),i=es(xa(a,Xi(Ta(-2,a))),n);return ls(i,-1)}))},categoricalCrossentropy:Kh,sparseCategoricalCrossentropy:qh,binaryCrossentropy:Hh,kullbackLeiblerDivergence:function(e,t){return wn((()=>{const n=ti(e,Yl(),1),a=ti(t,Yl(),1);return Ri(Ta(e,Zi(Na(n,a))),-1)}))},poisson:function(e,t){return wn((()=>{const n=Zi(xa(Yl(),t));return ls(es(t,Ta(e,n)),-1)}))},cosineProximity:Jh};function Yh(e){if("string"==typeof e){if(e in Zh)return Zh[e];let t=`Unknown loss ${e}`;throw e.toLowerCase().includes("softmaxcrossentropy")&&(t=`Unknown loss ${e}. Use "categoricalCrossentropy" as the string name for tf.losses.softmaxCrossEntropy`),new il(t)}return e}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function Qh(e,t){return wn((()=>{const n=Ta(.5,fs(t)),a=Ql(Vi(t,n),e.dtype);return ls(bi(e,a),-1)}))}function Xh(e,t){return wn((()=>Ql(bi(Aa(e,-1),Aa(t,-1)),"float32")))}function ep(e,t){return Hh(e,t)}function tp(e,t){return e.rank===t.rank&&(e=cr(e,[e.rank-1])),(t=Aa(t,-1)).dtype!==e.dtype&&(t=ra(t,e.dtype)),ra(bi(e,t),"float32")}const np=Kh,ap=qh,ip={binaryAccuracy:Qh,categoricalAccuracy:Xh,precision:function(e,t){return wn((()=>{const n=function(e,t){return wn((()=>ra(Ri(as(bi(e,1),bi(t,1))),"float32")))}(e,t),a=function(e,t){return wn((()=>ra(Ri(as(bi(e,0),bi(t,1))),"float32")))}(e,t),i=xa(n,a);return ra(wi(Vi(i,0),Na(n,i),0),"float32")}))},categoricalCrossentropy:np,sparseCategoricalCrossentropy:ap,mse:Wh,MSE:Wh,mae:Gh,MAE:Gh,mape:Vh,MAPE:Vh,cosine:Jh};function sp(e){if("string"==typeof e&&e in ip)return ip[e];if("string"!=typeof e&&null!=e)return e;throw new il(`Unknown metric ${e}`)}function rp(e){if(cl(null!==e,`Unknown LossOrMetricFn ${e}`),"string"==typeof e)return e;{let t;for(const n of Object.keys(Zh))if(Zh[n]===e){t=n;break}if(void 0!==t)return t;for(const n of Object.keys(ip))if(ip[n]===e){t=n;break}return void 0!==t?t:e.name}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
/**
     * @license
     * Copyright 2019 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
const op=1048576;function lp(e,t,n=!1){if(null==e||"object"!=typeof e||Object.getPrototypeOf(e)!==Object.prototype||!cp(e))throw new Error("User-defined metadata is expected to be a JSON object, but is not.");if(n){const n=JSON.stringify(e);n.length>op&&console.warn(`User-defined metadata of model "${t}" is too large in size (length=${n.length} when serialized). It is not recommended to store such large objects in user-defined metadata. Please make sure its serialized length is <= 1048576.`)}}function cp(e){if(null===e)return!0;if("object"==typeof e){if(Object.getPrototypeOf(e)===Object.prototype){const t=Object.keys(e);for(const n of t){if("string"!=typeof n)return!1;if(!cp(e[n]))return!1}return!0}if(Array.isArray(e)){for(const t of e)if(!cp(t))return!1;return!0}return!1}{const t=typeof e;return"string"===t||"number"===t||"boolean"===t}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function up(e,t,n,a=console.log){const i=function(e){let t=!0;const n=[],a=[];for(const t in e.nodesByDepth)n.push(e.nodesByDepth[t]);for(const e of n){if(e.length>1||1===e.length&&e[0].inboundLayers.length>1){t=!1;break}a.push(...e)}if(t)for(const n of e.layers){let e=!1;for(const i of n.inboundNodes)if(-1!==a.indexOf(i)){if(e){t=!1;break}e=!0}if(!t)break}return t}(e),s=["Layer (type)","Input Shape","Output shape","Param #"];let r;if(i?(t=t||90,n=n||[.32,.61,.89,1]):(t=t||115,n=n||[.24,.48,.7,.8,1]),n[n.length-1]<=1&&(n=n.map((e=>Math.floor(t*e)))),!i){s.push("Receives inputs"),r=[];for(const t in e.nodesByDepth)r.push(...e.nodesByDepth[t])}a("_".repeat(t)),hp(s,n,a),a("=".repeat(t));const o=e.layers;for(let e=0;e<o.length;++e)i?pp(o[e],n,a):dp(o[e],n,r,a),a((e===o.length-1?"=":"_").repeat(t));e.checkTrainableWeightsConsistency();const l=function(e){let t;t=null!=e.collectedTrainableWeights?Pc(e.collectedTrainableWeights):Pc(e.trainableWeights);return t}(e),c=Pc(e.nonTrainableWeights);a(`Total params: ${l+c}`),a(`Trainable params: ${l}`),a(`Non-trainable params: ${c}`),a("_".repeat(t))}function hp(e,t,n=console.log){let a="";for(let n=0;n<e.length;++n)n>0&&(a=a.slice(0,a.length-1)+" "),a+=e[n],a=a.slice(0,t[n]),a+=" ".repeat(t[n]-a.length);n(a)}function pp(e,t,n){let a,i;try{i=e.inboundNodes.map((e=>JSON.stringify(e.inputShapes))).join(",")}catch(e){i="multiple"}try{a=JSON.stringify(e.outputShape)}catch(e){a="multiple"}hp([`${e.name} (${e.getClassName()})`,i,a,e.countParams().toString()],t,n)}function dp(e,t,n,a){let i,s;try{s=e.inboundNodes.map((e=>JSON.stringify(e.inputShapes))).join(",")}catch(e){s="multiple"}try{i=JSON.stringify(e.outputShape)}catch(e){i="multiple"}const r=[];for(const t of e.inboundNodes)if(!(null!=n&&n.length>0&&-1===n.indexOf(t)))for(let e=0;e<t.inboundLayers.length;++e){const n=t.inboundLayers[e].name,a=t.nodeIndices[e],i=t.tensorIndices[e];r.push(`${n}[${a}][${i}]`)}const o=e.name,l=e.getClassName(),c=0===r.length?"":r[0];hp([`${o} (${l})`,s,i,e.countParams().toString(),c],t,a);for(let e=1;e<r.length;++e)hp(["","","","",r[e]],t,a)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function fp(e,t,n){return("inboundNodes"===e||"outputLayers"===e||"inputLayers"===e)&&0===t&&"string"==typeof n}function mp(e,t){if(null===e)return null;if("string"==typeof e)return fl(e);if("number"==typeof e||"boolean"==typeof e)return e;if(e instanceof Array){const n=[],a=e.length;for(let i=0;i<a;++i){const a=e[i];fp(t,i,a)?n.push(a):n.push(mp(a,t))}return n}{const t={};for(const n of Object.keys(e)){const a=e[n];if("name"===n&&"string"==typeof a)t[n]=a;else{const e=fl(n);t[e]=mp(a,e)}}return t}}function gp(e,t){if(null==e)return null;if("string"==typeof e)return dl(e);if("number"==typeof e||"boolean"==typeof e)return e;if(e instanceof Array){const n=[],a=e.length;for(let i=0;i<a;++i){const a=e[i];fp(t,i,a)?n.push(a):n.push(gp(a,t))}return n}{const t={};for(const n of Object.keys(e)){const a=e[n],i=dl(n);t[i]="name"!==n&&"className"!==n||"string"!=typeof a?gp(a,n):a}return t}}
/** @license See the LICENSE file. */const vp="4.22.0";
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */class yp extends Zc{constructor(e){if(super({}),this.containerNodes=new Set,this.name=e.name,null==this.name){const e=this.getClassName().toLowerCase();this.name=El(e)}if(this.supportsMasking=!1,this.trainable_=!0,Array.isArray(e.inputs)?this.inputs=e.inputs.slice():this.inputs=[e.inputs],Array.isArray(e.outputs)?this.outputs=e.outputs.slice():this.outputs=[e.outputs],wl(this.inputs).length!==this.inputs.length)throw new il(`The list of inputs passed to the model is redundant. All inputs should only appear once. Found: ${this.inputs.map((e=>e.name))}`);wl(this.outputs).length!==this.outputs.length&&console.warn(`The list of outputs passed to the model is redundant. All outputs should only appear once. Found: ${this.outputs.map((e=>e.name))}`),this.inputLayers=[],this.inputLayersNodeIndices=[],this.inputLayersTensorIndices=[],this.outputLayers=[],this.outputLayersNodeIndices=[],this.outputLayersTensorIndices=[],this.layers=[],this.internalContainerRefs=[];for(const e of this.outputs){const t=e.sourceLayer,n=e.nodeIndex,a=e.tensorIndex;this.outputLayers.push(t),this.outputLayersNodeIndices.push(n),this.outputLayersTensorIndices.push(a)}for(const e of this.inputs){const t=e.sourceLayer,n=e.nodeIndex,a=e.tensorIndex;cl(0===n,"input layer has >1 nodes"),cl(0===a,"input layer has >1 tensors"),this.inputLayers.push(t),this.inputLayersNodeIndices.push(n),this.inputLayersTensorIndices.push(a)}this.inputNames=[],this.outputNames=[],this.feedInputShapes=[],this.feedInputNames=[],this.feedOutputNames=[];for(let t=0;t<this.inputLayers.length;t++){const n=this.inputLayers[t];if(!(n instanceof Qc))throw new TypeError(`Input layers to a LayersModel must be InputLayer objects. Received inputs: ${e.inputs}. Input ${t} (0-based) originates from layer type ${n.getClassName()}.`);this.inputNames.push(n.name),this.feedInputShapes.push(n.batchInputShape),this.feedInputNames.push(n.name)}for(const e of this.outputLayers)this.outputNames.push(e.name);this.internalInputShapes=this.inputs.map((e=>e.shape)),this.internalOutputShapes=this.outputs.map((e=>e.shape));const t={},n={},a={},i={},s={},r=[],o=(e,t,n,a,i,l)=>{null!=a&&null!=i&&null!=l||(a=e.sourceLayer,i=e.nodeIndex,l=e.tensorIndex);const c=a.inboundNodes[i];if(-1!==n.indexOf(c))throw new al(`The tensor ${e.name} at layer "${a.name}" is part of a cycle.`);if(-1!==t.indexOf(c))return;this.containerNodes.add(yp.nodeKey(a,i)),a.id in s||(s[a.id]=Object.keys(s).length),-1===n.indexOf(c)&&n.push(c);const u=c.inboundLayers.length;for(let e=0;e<u;e++){const a=c.inputTensors[e],i=c.inboundLayers[e],s=c.nodeIndices[e],r=c.tensorIndices[e];o(a,t,n,i,s,r)}for(t.push(c);n.indexOf(c)>=0;)n.splice(n.indexOf(c),1);r.push(c)},l=[],c=[];for(const e of this.outputs)o(e,l,c);const u=r.slice().reverse();for(const e of u){n[e.id]=e,e.id in t||(t[e.id]=0);let s=t[e.id];const r=null==a[e.outboundLayer.id]?0:a[e.outboundLayer.id];s=Math.max(s,r),a[e.outboundLayer.id]=s,i[e.outboundLayer.id]=e.outboundLayer,t[e.id]=s;for(let a=0;a<e.inboundLayers.length;a++){const i=e.inboundLayers[a],r=e.nodeIndices[a],o=i.inboundNodes[r],l=null==t[o.id]?0:t[o.id];t[o.id]=Math.max(s+1,l),n[o.id]=o}}const h={};for(const e in t){const a=t[e];a in h||(h[a]=[]),h[a].push(n[e])}const p={};for(const e in a){const t=a[e];t in p||(p[t]=[]),p[t].push(i[e])}let d=Object.keys(p).map((e=>parseInt(e,10))).sort(bl);this.layers=[];for(const e of d){const t=p[e];t.sort(((e,t)=>{const n=s[e.id],a=s[t.id];return n<a?-1:n>a?1:0}));for(const e of t)e instanceof yp&&this.internalContainerRefs.push(e),this.layers.push(e)}this.layersByDepth=p,d=Object.keys(h).map((e=>parseInt(e,10))).sort(bl);const f=this.inputs.slice(),m=[];for(const e of d)for(const t of h[e]){const e=t.outboundLayer;if(null!=e){for(const n of t.inputTensors)if(-1===f.indexOf(n))throw new al(`Graph disconnected: cannot obtain value for tensor ${n} at layer "${e.name}". The following previous layers were accessed without issue: ${m}`);for(const e of t.outputTensors)f.push(e);m.push(e.name)}}this.nodesByDepth=h;const g=this.layers.map((e=>e.name));for(const e of g){const t=g.filter((t=>t===e)).length;if(1!==t)throw new al(`The name "${e}" is used ${t} times in the model. All layer names should be unique. Layer names: `+JSON.stringify(g))}this.outboundNodes=[],this.inboundNodes=[],new Hc({outboundLayer:this,inboundLayers:[],nodeIndices:[],tensorIndices:[],inputTensors:this.inputs,outputTensors:this.outputs,inputMasks:this.inputs.map((e=>null)),outputMasks:this.outputs.map((e=>null)),inputShapes:this.inputs.map((e=>e.shape)),outputShapes:this.outputs.map((e=>e.shape))}),this.built=!0,this._refCount=1}assertNotDisposed(){if(0===this._refCount)throw new Error(`Container '${this.name}' is already disposed.`)}dispose(){this.assertNotDisposed();const e={refCountAfterDispose:null,numDisposedVariables:0};if(0==--this._refCount){for(const t of this.layers)e.numDisposedVariables+=t.dispose().numDisposedVariables;for(const t of this.internalContainerRefs)e.numDisposedVariables+=t.dispose().numDisposedVariables}return e.refCountAfterDispose=this._refCount,e}get trainable(){return this.trainable_}set trainable(e){this.layers.forEach((t=>{t._trainableWeights.forEach((t=>t.trainable=e))})),this.trainable_=e}get trainableWeights(){if(this._trainableWeights.length>0)throw new il("Container instance unexpectedly contains _trainableWeights.The trainable weights of a Container are a union of the trainable weights of its consituent Layers. Its own _trainableWeights must remain an empty Array.");if(!this.trainable)return[];let e=[];for(const t of this.layers)e=e.concat(t.trainableWeights);return e}get nonTrainableWeights(){const e=[];for(const t of this.layers)e.push(...t.nonTrainableWeights);if(!this.trainable){const t=[];for(const e of this.layers)t.push(...e.trainableWeights);return t.concat(e)}return e}get weights(){return this.trainableWeights.concat(this.nonTrainableWeights)}loadWeights(e,t=!0){const n={};let a=0;const i=(e=>{const t=Object.keys(e);if(0===t.length)return!1;const n=t[0].split("/");return!isNaN(parseInt(n[n.length-1],10))})(e);i&&this.parseWeights(e);for(const e of this.layers)for(const[t,s]of e.weights.entries()){const e=i?`${s.name.split("/").slice(0,-1).join("/")+"/"}${t}`:s.originalName;if(null!=n[e])throw new il(`Duplicate weight name: ${e}`);n[e]=s,a++}const s=[];for(const a in e){let i=a;if(null==n[a]){const e=a.split("/");i=e.slice(0,-2).concat([e[e.length-1]]).join("/")}if(null!=n[i])s.push([n[i],e[a]]);else if(t)throw new il(`Provided weight data has no target variable: ${a}`);delete n[i]}if(t){const e=[];for(const t in n)e.push(t);if(e.length>0)throw new il(`${e.length} of ${a} weights are not set: ${e}`)}Gc(s)}parseWeights(e){for(const t in Object.keys(e)){const n=t.split("/"),a=["vars","layer_checkpoint_dependencies"],i=n.map((e=>e.startsWith("_")?e.slice(1):e)).filter((e=>!a.includes(e))).join("/");i!==t&&(e[i]=e[t],delete e[t])}}updatedConfig(){const e=this.getConfig(),t={};return t.className=this.getClassName(),t.config=e,t.kerasVersion=`tfjs-layers ${vp}`,t.backend="TensorFlow.js",t}toJSON(e,t=!0){const n=gp(this.updatedConfig());return t?JSON.stringify(n):n}call(e,t){return wn((()=>{e=pl(e);const n=new Xc;for(let t=0;t<this.inputs.length;++t)n.add(this.inputs[t],e[t]);return nu(this.outputs,n,t)}))}computeMask(e,t){return wn((()=>{let n;return e=pl(e),n=null==t?ll(null,e.length):pl(t),this.runInternalGraph(e,n)[1]}))}computeOutputShape(e){const t=Lc(e);if(t.length!==this.inputLayers.length)throw new il(`Invalid inputShape argument ${e}: model has ${this.inputLayers.length} tensor inputs.`);const n={};for(let e=0;e<t.length;e++){const a=this.inputLayers[e],i=t[e];n[a.name+"_0_0"]=i}const a=Object.keys(this.nodesByDepth).map((e=>parseInt(e,10))).sort(bl);if(a.length>1)for(const e of a){const t=this.nodesByDepth[e];for(const e of t){const t=e.outboundLayer;if(-1!==this.inputLayers.map((e=>e.id)).indexOf(t.id))continue;const a=[];for(let t=0;t<e.inboundLayers.length;t++){const i=e.inboundLayers[t],s=e.nodeIndices[t],r=e.tensorIndices[t],o=n[`${i.name}_${s}_${r}`];a.push(o)}const i=Lc(t.computeOutputShape(hl(a))),s=t.inboundNodes.indexOf(e);for(let e=0;e<i.length;e++){n[`${t.name}_${s}_${e}`]=i[e]}}}const i=[],s=[];for(let e=0;e<this.outputLayers.length;e++){const t=this.outputLayers[e],n=this.outputLayersNodeIndices[e],a=this.outputLayersTensorIndices[e],i=`${t.name}_${n}_${a}`;s.push(i)}for(let e=0;e<s.length;e++){const t=s[e];cl(t in n),i.push(n[t])}return hl(i)}runInternalGraph(e,t){null==t&&(t=ll(null,e.length));const n={};for(let a=0;a<this.inputs.length;++a){const i=this.inputs[a],s=e[a],r=t[a];n[i.id]=[s,r]}const a=Object.keys(this.nodesByDepth).map((e=>parseInt(e,10))).sort(bl);for(const e of a){const t=this.nodesByDepth[e];for(const e of t){const t=e.outboundLayer,a=e.inputTensors,i=e.outputTensors,s=new Array;for(const e of a)e.id in n&&s.push(n[e.id]);if(s.length===a.length){let a,r,o,l,c={};if(null!=e.callArgs&&(c=e.callArgs),1===s.length){const[e,n]=s[0];null==c.mask&&(c.mask=n),o=pl(t.call(e,c)),l=pl(t.computeMask(e,n)),a=[e],r=[n]}else a=s.map((e=>e[0])),r=s.map((e=>e[1])),null==c.mask&&(c.mask=r),o=pl(t.call(a,c)),l=pl(t.computeMask(a,r));if(t.activityRegularizer)throw new sl("LayersModel invocation with concrete Tensor value(s) in the presence of activity regularizer(s) is not supported yet.");for(let e=0;e<i.length;++e){const t=i[e],a=o[e],s=l[e];n[t.id]=[a,s]}}}}const i=[],s=[],r=[];for(const e of this.outputs){cl(e.id in n,`Could not compute output ${e.name} : ${e.id}`);const[t,a]=n[e.id];r.push(t.shape),i.push(t),s.push(a)}return[i,s,r]}buildNodeConversionMap(e){const t={};let n;for(const e of this.layers){n=e instanceof yp?1:0;for(let a=0;a<e.inboundNodes.length;a++){const i=yp.nodeKey(e,a);this.containerNodes.has(i)&&(t[i]=n,n+=1)}}return t}getLayer(e,t){if(null!=t)return this.findLayer(t);if(null==e)throw new il("Provide either a layer name or layer index");if("number"==typeof e)return this.findLayer(e);for(const t of this.layers)if(t.name===e)return t;throw new il(`No such layer: ${e}`)}findLayer(e){if(this.layers.length<=e)throw new il(`Was asked to retrieve layer at index ${e}, but model only has ${this.layers.length} layer(s).`);return this.layers[e]}calculateLosses(){return wn((()=>{const e=[];for(const t of this.layers)for(let n=0;n<t.inboundNodes.length;++n){const a=yp.nodeKey(t,n);this.containerNodes.has(a)&&e.push(...t.calculateLosses())}return e}))}getConfig(){const e={name:this.name},t=this.buildNodeConversionMap(this.layers),n=[];for(const e of this.layers){const a=e.getClassName(),i=e.getConfig(),s=[];for(let n=0;n<e.inboundNodes.length;n++){const a=e.inboundNodes[n],i=yp.nodeKey(e,n);let r={};if(this.containerNodes.has(i)){if(a.callArgs)try{JSON.stringify(a.callArgs),r=a.callArgs}catch(t){console.warn(`Layer ${e.name} was passed non-serializable keyword arguments: ${a.callArgs}. They will not be included in the serialized model (and thus will be missing at deserialization time).`),r={}}if(a.inboundLayers.length>0){const e=[];for(let n=0;n<a.inboundLayers.length;n++){const i=a.inboundLayers[n],s=a.nodeIndices[n],o=a.tensorIndices[n];let l=t[yp.nodeKey(i,s)];null==l&&(l=0),e.push([i.name,l,o,r])}s.push(e)}}}const r={};r.name=e.name,r.className=a,r.config=i,r.inboundNodes=s,n.push(r)}e.layers=n;const a=[];for(let e=0;e<this.inputLayers.length;e++){const n=this.inputLayers[e],i=this.inputLayersNodeIndices[e],s=yp.nodeKey(n,i);if(!this.containerNodes.has(s))continue;let r=t[s];null==r&&(r=0);const o=this.inputLayersTensorIndices[e];a.push([n.name,r,o])}e.inputLayers=a;const i=[];for(let e=0;e<this.outputLayers.length;e++){const n=this.outputLayers[e],a=this.outputLayersNodeIndices[e],s=yp.nodeKey(n,a);if(!this.containerNodes.has(s))continue;let r=t[s];null==r&&(r=0);const o=this.outputLayersTensorIndices[e];i.push([n.name,r,o])}return e.outputLayers=i,e}static fromConfig(e,t,n={},a=!1){const i={},s={};function r(e,t){e.name in s?s[e.name].push(t):s[e.name]=[t]}function o(e,t){const n=[];let a;for(const s of t){const o=s[0],l=s[1],c=s[2];if(a=null==s[3]?{}:s[3],!(o in i))return void r(e,t);const u=i[o];if(u.inboundNodes.length<=l)return void r(e,t);const h=u.inboundNodes[l];n.push(h.outputTensors[c])}n.length>0&&e.apply(hl(n),a)}function l(e){const n=e.name,s=Bh(e,null!=t.customObjects?t.customObjects:{});s.setFastWeightInitDuringBuild(a),i[n]=s;e.inboundNodes.forEach((e=>{if(!(e instanceof Array))throw new il(`Corrupted configuration, expected array for nodeData: ${e}`);r(s,e)}))}const c=t.name,u=t.layers;for(const e of u)l(e);for(;!kl(s);)for(const e of u){const t=i[e.name];if(t.name in s){const e=s[t.name];delete s[t.name];for(const n of e)o(t,n)}}const h=[],p=[],d=t.inputLayers;for(const e of d){const t=e[0],n=e[1],a=e[2];cl(t in i);const s=i[t].inboundNodes[n].outputTensors;h.push(s[a])}const f=t.outputLayers;for(const e of f){const t=e[0],n=e[1],a=e[2];cl(t in i);const s=i[t].inboundNodes[n].outputTensors;p.push(s[a])}return new e({inputs:h,outputs:p,name:c})}get stateful(){if(this._stateful)throw new il("Container instance unexpectedly has _stateful = true. The statefulness of a Container is determined by the Layers it contains. Its _stateful property must remain the default false.");for(const e of this.layers)if(e.stateful)return!0;return!1}resetStates(){wn((()=>{this.layers.forEach((e=>{e.stateful&&e.resetStates()}))}))}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function bp(e,t){return function(e,t,n){const a=t.length;if(null==e||Array.isArray(e)&&0===e.length)return t.map((e=>null));if(1===a)return Array.isArray(e)&&1===e.length?e:"object"==typeof e&&t[0]in e?[e[t[0]]]:[e];if(Array.isArray(e)){if(e.length!==a)throw new Error(`Provided ${n} is an array of ${e.length} element(s), but the model has ${a} outputs. Make sure a set of weights is provided for each model output.`);return e}if("object"==typeof e&&Object.keys(e).length>0&&"object"==typeof e[Object.keys(e)[0]]){const n=[];return t.forEach((t=>{t in e?n.push(e[t]):n.push(null)})),n}throw new Error(`The model has multiple (${a}) outputs, so ${n} must be either an array with ${a} elements or an object with ${t} keys. Provided ${n} not understood: ${JSON.stringify(e)}`)}(e,t,"classWeight")}async function wp(e,t,n,a){if(null!=n){const t=wn((()=>{if(1===e.shape.length)return Ba(e);if(2===e.shape.length){if(e.shape[1]>1){return Aa(e,1)}if(1===e.shape[1])return Ma(e,[e.shape[0]]);throw new Error(`Encountered unexpected last-dimension size (${e.shape[1]}) during handling of class weights. The size is expected to be >= 1.`)}throw new Error(`Unexpected rank of target (y) tensor (${e.rank}) during handling of class weights. The rank is expected to be 1 or 2.`)})),a=Array.from(await t.data());kn(t);const i=[];return a.forEach((e=>{if(null==n[e])throw new Error(`classWeight must contain all classes in the training data. The class ${e} exists in the data but not in classWeight`);i.push(n[e])})),pr(i,"float32")}return null}function kp(e,t){return Ta(e,t)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function xp(e,t){let n,a;const i=t;n=i.xs,a=i.ys,x(null!=n&&null!=a,(()=>`A Dataset iterator for fitDataset() is expected to generate objects of the form \`{xs: xVal, ys: yVal}\`, where the two values may be \`tf.Tensor\`, an array of Tensors, or a map of string to Tensor.  The provided Dataset instead generates ${t}`));const s=Sp("input",e.inputNames,n),r=Sp("output",e.outputNames,a),o=s[0].shape[0];x(s.length===e.inputs.length,(()=>`LayersModel has ${e.inputs.length} inputs, but the dataset provides ${s.length} inputs.  (Expected input keys: ${JSON.stringify(e.inputNames)})`)),x(r.length===e.outputs.length,(()=>`LayersModel has ${e.outputs.length} outputs, but the dataset provides ${r.length} outputs.  (Expected output keys: ${JSON.stringify(e.outputNames)})`));for(let t=0;t<s.length;t++)x(s[t].shape[0]===o,(()=>`Batch size mismatch: input ${e.inputNames[t]} has ${s[t].shape[0]}; expected  ${o} based on input ${e.inputNames[0]}.`));for(let t=0;t<r.length;t++)x(r[t].shape[0]===o,(()=>`Batch size mismatch: output ${e.outputNames[t]} has ${r[t].shape[0]}; expected  ${o} based on input ${e.inputNames[0]}.`));return{xs:s,ys:r}}function Sp(e,t,n){if(n instanceof Mt)return[n];if(Array.isArray(n))return x(n.length===t.length,(()=>`Received an array of ${n.length} Tensors, but expected ${t.length} to match the ${e} keys ${t}.`)),n;{const a=[];for(const i of t){if(null==n[i])throw new il(`The feature data generated by the dataset lacks the required ${e} key '${i}'.`);a.push(n[i])}return a}}async function Np(e,t,n){const a=null!=n.batchesPerEpoch;if(x(null!=e.optimizer,(()=>"You must compile a model before training/testing. Use LayersModel.compile(modelCompileConfig).")),x(null!=n,(()=>"For fitDataset(), the 2nd argument (config) is required, but it is not provided in this call.")),x(null!=n.epochs&&n.epochs>0&&Number.isInteger(n.epochs),(()=>`For fitDataset(), config.epochs is expected to be a positive integer, but got ${n.epochs}`)),x(!a||n.batchesPerEpoch>0&&Number.isInteger(n.batchesPerEpoch),(()=>`For fitDataset(), config.batchesPerEpoch is expected to be a positive integer if specified, but got ${n.batchesPerEpoch}`)),x(null==n.validationSplit,(()=>"`validationSplit` is not supported by `fitDataset()`. Use validationData instead.")),e.isTraining)throw new Error("Cannot start training because another fit() call is ongoing.");e.isTraining=!0;try{const i=null!=n.validationData;let s,r;if(i)if(Tp(n.validationData))x(null==n.validationBatches||n.validationBatches>0&&Number.isInteger(n.validationBatches),(()=>`For fitDataset() with dataset-based validation, config.validationBatches is expected not to be provided, or to be a positive integer, but got ${n.validationBatches}`));else{const e=function(e){if(3===e.length)throw new sl("Validation with sample weights is not implemented yet.");return{xs:e[0],ys:e[1]}}(n.validationData);s=e.xs,r=e.ys}const o=e.makeTrainFunction(),l=e.getDedupedMetricsNames();let c;c=i?l.slice().concat(l.map((e=>"val_"+e))):l.slice();const u=Mh(n.callbacks,n.yieldEvery),h=null==n.verbose?1:n.verbose,{callbackList:p,history:d}=Ph(u,h,n.epochs,null,null,function(e,t){let n=null;null!=t.batchesPerEpoch?n=t.batchesPerEpoch:Number.isFinite(e.size)&&(n=e.size);return n}(t,n),null,i,c);p.setModel(e),e.history=d,await p.onTrainBegin(),e.stopTraining_=!1;let f=null==n.initialEpoch?0:n.initialEpoch,m=await t.iterator();for(;f<n.epochs;){const c={};await p.onEpochBegin(f);let u=0,h=0;for(a||(m=await t.iterator());!a||u<n.batchesPerEpoch;){const t=await m.next();if(a&&t.done){console.warn(`You provided \`batchesPerEpoch\` as ${n.batchesPerEpoch}, but your dataset iterator ran out of data after ${u} batches; interrupting training. Make sure that your dataset can generate at least \`batchesPerEpoch * epochs\` batches (in this case, `+n.batchesPerEpoch*n.epochs+" batches). You may need to use the repeat() function when building your dataset.");break}if(null!=t.value){const{xs:a,ys:i}=xp(e,t.value),s={};s.batch=h,s.size=a[0].shape[0],await p.onBatchBegin(h,s);const r=[];if(null!=n.classWeight){const t=bp(n.classWeight,e.outputNames);for(let e=0;e<t.length;++e)r.push(await wp(i[e],0,t[e]))}const c=a.concat(i).concat(r),d=o(c);kn(c);for(let e=0;e<l.length;++e){const t=l[e],n=d[e];s[t]=n,xn(n)}await p.onBatchEnd(h,s),jh(s),h++,u++}if(a?u>=n.batchesPerEpoch:t.done){if(i){let t;t=Tp(n.validationData)?pl(await e.evaluateDataset(n.validationData,{batches:n.validationBatches})):pl(e.evaluate(s,r,{batchSize:null==n.validationBatchSize?32:n.validationBatchSize,verbose:0}));for(let n=0;n<e.metricsNames.length;++n)c[`val_${e.metricsNames[n]}`]=t[n]}break}if(e.stopTraining_)break}if(await p.onEpochEnd(f,c),f++,e.stopTraining_)break}return await p.onTrainEnd(),await e.history.syncData(),e.history}finally{e.isTraining=!1}}function Tp(e){return"function"==typeof e.iterator}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function Ip(e){x(e>0&&Number.isInteger(e),(()=>`batchSize is required to be a positive integer, but got ${e}`))}function Cp(e,t,n){return null==e?[null]:Array.isArray(e)?e.map((e=>ec(e,t,n-t))):ec(e,t,n-t)}function $p(e,t){return wn((()=>null==e?null:Array.isArray(e)?e.map((e=>$p(e,t))):lc(e,"int32"===t.dtype?t:ra(t,"int32"))))}function Ap(e,t){const n=[];let a=0,i=null;for(;a<e;)i=a+t,i>=e&&(i=e),n.push([a,i]),a=i;return n}function Ep(e){const t=[];e instanceof Mt&&(e=[e]);for(let n=0;n<e.length;++n){const a=e[n];if(1===a.rank)t.push(Xl(a,1));else{if(0===a.rank)throw new Error("Expected tensor to be at least 1D, but received a 0D tensor (scalar).");t.push(a)}}return t}function jp(e,t){if(null==e)return;const n=[];if(t instanceof Mt)n.push(t.id);else if(Array.isArray(t))t.forEach((e=>n.push(e.id)));else if(null!=t)for(const e in t){const a=t[e];n.push(a.id)}const a=[];if(e instanceof Mt)-1===n.indexOf(e.id)&&a.push(e);else if(Array.isArray(e))e.forEach((e=>{-1===n.indexOf(e.id)&&a.push(e)}));else if(null!=e)for(const t in e){const i=e[t];-1===n.indexOf(i.id)&&a.push(i)}a.forEach((e=>{e.isDisposed||e.dispose()}))}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function zp(e){return Array.isArray(e)}function Dp(e){return!function(e){return e instanceof Mt}(e)&&!zp(e)}function Fp(e,t,n,a=!0,i=""){if(null==t||0===t.length){if(null!=e){let t=!1;if(zp(e)&&e.length>0)t=!0;else if(Dp(e)){for(const n in e)if(e.hasOwnProperty(n)){t=!0;break}}else t=!0;if(t)throw new il(`Error when checking model ${i} expected no data, but got ${e}`)}return[]}if(null==e)return t.map((e=>null));let s;if(Dp(e)){s=[];for(const n of t){if(null==e[n])throw new il(`No data provided for "${n}". Need data for each key in: ${t}`);s.push(e[n])}}else if(zp(e)){if(e.length!==t.length)throw new il(`Error when checking model ${i}: the Array of Tensors that you are passing to your model is not the size the model expected. Expected to see ${t.length} Tensor(s), but instead got the following list of Tensor(s): ${e}`);s=e}else{if(t.length>1)throw new il(`The model ${i} expects ${t.length} Tensor(s), but only received one Tensor. Found: Tensor with shape ${e.shape}`);s=[e]}if(s=Ep(s),null!=n)for(let e=0;e<t.length;++e){if(null==n[e])continue;const r=s[e];if(r.shape.length!==n[e].length)throw new il(`Error when checking ${i}: expected ${t[e]} to have ${n[e].length} dimension(s). but got array with shape ${r.shape}`);for(let t=0;t<n[e].length;++t){if(0===t&&!a)continue;const s=r.shape[t],o=n[e][t];if(null!=o&&o>=0&&s!==o)throw new il(`${i} expected a batch of elements where each example has shape [${n[e].slice(1,n[e].length)}] (i.e.,tensor shape [*,${n[e].slice(1,n[e].length)}]) but the ${i} received an input with ${r.shape[0]} examples, each with shape [${r.shape.slice(1,r.shape.length)}] (tensor shape [${r.shape}])`)}}return s}function _p(e,t,n,a=!0,i=""){let s;if(Array.isArray(e)){if(e.length!==t.length)throw new il(`Error when checking model ${i}: the Array of Tensors that you are passing to your model is not the size the the model expected. Expected to see ${t.length} Tensor(s), but instead got ${e.length} Tensors(s).`);s=e}else{if(t.length>1)throw new il(`The model expects ${t.length} ${i} Tensors, but only received one Tensor. Found: array with shape ${JSON.stringify(e.shape)}.`);s=[e]}if(null!=n)for(let e=0;e<t.length;++e){if(null==n[e])continue;const r=s[e];if(r.shape.length!==n[e].length)throw new il(`Error when checking ${i}: expected ${t[e]} to have ${n[e].length} dimension(s), but got array with shape ${JSON.stringify(r.shape)}`);for(let s=0;s<n[e].length;++s){if(0===s&&!a)continue;const o=r.shape[s],l=n[e][s];if(null!=l&&l!==o)throw new il(`Error when checking ${i}: expected ${t[e]} to have shape ${JSON.stringify(n[e])} but got array with shape ${JSON.stringify(r.shape)}.`)}}}class Rp extends yp{constructor(e){super(e),this.isTraining=!1}summary(e,t,n=console.log){if(!this.built)throw new il("This model has never been called, thus its weights have not been created yet. So no summary can be displayed. Build the model first (e.g., by calling it on some test data).");up(this,e,t,n)}compile(e){if(null==e.loss&&(e.loss=[]),this.loss=e.loss,"string"==typeof e.optimizer)this.optimizer_=function(e){const t={Adagrad:()=>ro.adagrad(.01),Adadelta:()=>ro.adadelta(1,.95,Yl()),Adam:()=>ro.adam(.001,.9,.999,Yl()),Adamax:()=>ro.adamax(.002,.9,.999,Yl(),0),RMSProp:()=>ro.rmsprop(.001,.9,0,Yl()),SGD:()=>ro.sgd(.01)};if(t.adagrad=t.Adagrad,t.adadelta=t.Adadelta,t.adam=t.Adam,t.adamax=t.Adamax,t.rmsprop=t.RMSProp,t.sgd=t.SGD,e in t)return t[e]();throw new il(`Unknown Optimizer ${e}`)}(e.optimizer),this.isOptimizerOwned=!0;else{if(!(e.optimizer instanceof Qr))throw new il("User-defined optimizer must be an instance of tf.Optimizer.");this.optimizer_=e.optimizer,this.isOptimizerOwned=!1}let t=[];if(Array.isArray(e.loss)||"string"==typeof e.loss||"function"==typeof e.loss)if(Array.isArray(e.loss)){if(e.loss.length!==this.outputs.length)throw new il(`When passing an Array as loss, it should have one entry per model output. The model has ${this.outputs.length} output(s), but you passed loss=${e.loss}.`);const n=e.loss;t=n.map((e=>Yh(e)))}else{const n=Yh(e.loss);this.outputs.forEach((e=>{t.push(n)}))}else{e.loss=e.loss;for(const t in e.loss)if(-1===this.outputNames.indexOf(t))throw new il(`Unknown entry in loss dictionary: "${t}". Only expected the following keys: ${this.outputNames}`);for(const n of this.outputNames)null==e.loss[n]&&console.warn(`Output "${n}" is missing from loss dictionary. We assume this was done on purpose, and we will not be expecting data to be passed to ${n} during training`),t.push(Yh(e.loss[n]))}this.lossFunctions=t,this.feedOutputNames=[],this.feedOutputShapes=[],this.feedLossFns=[];for(let e=0;e<this.outputs.length;++e){const t=this.internalOutputShapes[e],n=this.outputNames[e];this.feedOutputNames.push(n),this.feedOutputShapes.push(t),this.feedLossFns.push(this.lossFunctions[e])}const n=[];this.metrics=e.metrics,this.metricsNames=["loss"],this.metricsTensors=[],Bl("loss",(()=>{for(let e=0;e<this.outputs.length;++e){if(-1!==n.indexOf(e))continue;const t=this.lossFunctions[e];this.outputs.length>1&&(this.metricsTensors.push([t,e]),this.metricsNames.push(this.outputNames[e]+"_loss"))}}));const a=function(e,t){if(null==e||Array.isArray(e)&&0===e.length)return t.map((e=>[]));let n;if("string"==typeof e||"function"==typeof e)n=[e];else{if(!Array.isArray(e)&&"object"!=typeof e)throw new TypeError(`Type of metrics argument not understood. Expected an string,function, Array, or Object, found: ${e}`);n=e}if(Array.isArray(n))return t.map((e=>n));{const e=[];for(const a of t){let t=n.hasOwnProperty(a)?n[a]:[];Array.isArray(t)||(t=[t]),e.push(t)}return e}}(e.metrics,this.outputNames),i=(e,t,n)=>{this.outputNames.length>1&&(t=this.outputNames[e]+"_"+t),this.metricsNames.push(t),this.metricsTensors.push([n,e])};Bl("metric",(()=>{for(let e=0;e<this.outputs.length;++e){if(-1!==n.indexOf(e))continue;(t=>{let n,a,s;for(const r of t){if("string"==typeof r&&-1!==["accuracy","acc","crossentropy","ce"].indexOf(r)){const t=this.internalOutputShapes[e];let i;1===t[t.length-1]||this.lossFunctions[e]===Hh?-1!==["accuracy","acc"].indexOf(r)?a=Qh:-1!==["crossentropy","ce"].indexOf(r)&&(a=ep):this.lossFunctions[e]===qh?-1!==["accuracy","acc"].indexOf(r)?a=tp:-1!==["crossentropy","ce"].indexOf(r)&&(a=ap):-1!==["accuracy","acc"].indexOf(r)?a=Xh:-1!==["crossentropy","ce"].indexOf(r)&&(a=np),-1!==["accuracy","acc"].indexOf(r)?i="acc":-1!==["crossentropy","ce"].indexOf(r)&&(i="ce"),s=a,n=""+i}else{const e=sp(r);s=e,n=""+rp(r)}let t;Bl(n,(()=>{t=s})),i(e,n,t)}})(a[e])}})),this.collectedTrainableWeights=this.trainableWeights}checkTrainableWeightsConsistency(){null!=this.collectedTrainableWeights&&this.trainableWeights.length!==this.collectedTrainableWeights.length&&console.warn("Discrepancy between trainableweights and collected trainable weights. Did you set `model.trainable` without calling `model.compile()` afterwards?")}evaluate(e,t,n={}){const a=null==n.batchSize?32:n.batchSize;Ip(a);const i=this.standardizeUserDataXY(e,t,!0,a);try{const e=i[0].concat(i[1]);this.makeTestFunction();const t=this.testFunction;return hl(this.testLoop(t,e,a,n.verbose,n.steps))}finally{jp(i[0],e),jp(i[1],t)}}async evaluateDataset(e,t){return this.makeTestFunction(),async function(e,t,n){const a=null!=(n=n||{}).batches,i=e.testFunction;let s=[];if(n.verbose>0)throw new sl("Verbose mode is not implemented yet.");x(!a||n.batches>0&&Number.isInteger(n.batches),(()=>`Test loop expects \`batches\` to be a positive integer, but received ${JSON.stringify(n.batches)}`));const r="function"==typeof t.next?t:await t.iterator();let o=0,l=0;for(;!a||l<n.batches;){const t=await r.next();if(s=wn((()=>{if(t.value){const{xs:n,ys:a}=xp(e,t.value),r=n.concat(a),c=wn((()=>i(r)));if(kn(r),0===l)for(let e=0;e<c.length;++e)s.push(Di(0));const u=r[0].shape[0];for(let e=0;e<c.length;++e){const t=c[e],n=s[e];s[e]=wn((()=>xa(s[e],Ta(u,t)))),l>0&&kn(n)}kn(c),o+=u,++l}return s})),t.done){a&&console.warn(`Your dataset iterator ran out of data during evaluateDataset(). Interrupting evalution. Make sure that your dataset can generate at least \`batches\` batches (in this case, ${n.batches} batches). You may need to use the repeat() function when building your dataset.`);break}}for(let e=0;e<s.length;++e){const t=s[e];s[e]=Na(s[e],o),kn(t)}return hl(s)}(this,e,t)}checkNumSamples(e,t,n,a="steps"){let i;if(null!=n){if(i=null,null!=t)throw new il(`If ${a} is set, batchSize must be null or undefined.Got batchSize = ${t}`)}else{if(null==e)throw new il(`Either the input data should have a defined shape, or ${a} shoud be specified.`);i=Array.isArray(e)?e[0].shape[0]:e.shape[0]}return i}execute(e,t){if(Array.isArray(t)&&0===t.length)throw new il("`outputs` is an empty Array, which is not allowed.");const n=Array.isArray(t),a=n?t:[t],i=this.retrieveSymbolicTensors(a),s=new Xc;if(e instanceof Mt&&(e=[e]),Array.isArray(e)){if(e.length!==this.inputs.length)throw new il(`The number of inputs provided (${e.length}) does not match the number of inputs of this model (${this.inputs.length}).`);for(let t=0;t<this.inputs.length;++t)s.add(this.inputs[t],e[t])}else for(const t of this.inputs){const n=e[t.name];if(null==n)throw new il(`No value is provided for the model's input ${t.name}`);s.add(t,n)}const r=nu(i,s);return n?r:r[0]}retrieveSymbolicTensors(e){const t=ll(null,e.length);let n=e.length;for(const a of this.layers){const i=Array.isArray(a.output)?a.output:[a.output],s=i.map((e=>e.name));for(let a=0;a<e.length;++a){const r=s.indexOf(e[a]);if(-1!==r&&(t[a]=i[r],n--),0===n)break}if(0===n)break}if(n>0){const n=[];throw t.forEach(((t,a)=>{null==t&&n.push(e[a])})),new il(`Cannot find SymbolicTensors for output name(s): ${JSON.stringify(n)}`)}return t}predictLoop(e,t=32,n=!1){return wn((()=>{const a=this.checkNumSamples(e);if(n)throw new sl("Verbose predictLoop() is not implemented yet.");const i=Ap(a,t),s=this.outputs.map((e=>[]));for(let t=0;t<i.length;++t){wn((()=>{const n=i[t][0],a=i[t][1],s=Cp(e,n,a),r=[];if(Array.isArray(s))for(let e=0;e<s.length;++e)r.push({key:this.inputs[e],value:s[e]});else r.push({key:this.inputs[0],value:s});const o=new Xc(r);return nu(this.outputs,o)})).forEach(((e,t)=>s[t].push(e)))}return hl(s.map((e=>Ua(e,0))))}))}predict(e,t={}){const n=Ep(e);_p(n,this.inputNames,this.feedInputShapes,!1);try{const e=null==t.batchSize?32:t.batchSize;return Ip(e),this.predictLoop(n,e)}finally{jp(n,e)}}predictOnBatch(e){_p(e,this.inputNames,this.feedInputShapes,!0);const t=(Array.isArray(e)?e[0]:e).shape[0];return this.predictLoop(e,t)}standardizeUserDataXY(e,t,n=!0,a){if(null==this.optimizer_)throw new al("You must compile a model before training/testing. Use LayersModel.compile(modelCompileArgs).");const i=[];for(let e=0;e<this.feedOutputShapes.length;++e){const t=this.feedOutputShapes[e];this.feedLossFns[e]===qh?i.push(t.slice(0,t.length-1).concat([1])):i.push(t)}if(function(e,t){const n=wl(e.map((e=>e.shape[0])));n.sort();const a=wl(t.map((e=>e.shape[0])));if(a.sort(),n.length>1)throw new il(`All input Tensors (x) should have the same number of samples. Got array shapes: ${JSON.stringify(e.map((e=>e.shape)))}`);if(a.length>1)throw new il(`All target Tensors (y) should have the same number of samples. Got array shapes: ${JSON.stringify(t.map((e=>e.shape)))}`);if(n.length>0&&a.length>0&&!T(n,a))throw new il(`Input Tensors should have the same number of samples as target Tensors. Found ${n[0]} input sample(s) and ${a[0]} target sample(s).`)}(e=Fp(e,this.feedInputNames,this.feedInputShapes,!1,"input"),t=Fp(t,this.feedOutputNames,i,!1,"target")),function(e,t,n){const a=[Wh,Hh,Kh];for(let i=0;i<e.length;++i){const s=e[i],r=t[i],o=n[i];if(null!=r){if(r===Kh&&1===s.shape[s.shape.length-1])throw new il(`You are passing a target array of shape ${s.shape} while using a loss 'categorical_crossentropy'. 'categorical_crossentropy'expects targets to be binary matrices (1s and 0s) of shape [samples, classes].`);if(-1!==a.indexOf(r)){const e=s.shape.slice(1),t=o.slice(1);for(let n=0;n<e.length;++n){const a=e[n],i=t[n];if(null!=i&&a!==i)throw new il(`A target Tensor with shape ${s.shape} was passed for an output of shape ${o}, while using a loss function that expects targets to have the same shape as the output.`)}}}}}(t,this.feedLossFns,this.feedOutputShapes),this.stateful&&null!=a&&a>0&&e[0].shape[0]%a!=0)throw new il(`In a stateful network, you should only pass inputs with a number of samples that is divisible by the batch size ${a}. Found: ${e[0].shape[0]} sample(s).`);return[e,t]}async standardizeUserData(e,t,n,a,i=!0,s){const[r,o]=this.standardizeUserDataXY(e,t,i,s);if(null!=n)throw new Error("sample weight is not supported yet.");let l=null;if(null!=a){const e=bp(a,this.outputNames);l=[];for(let t=0;t<e.length;++t)l.push(await wp(o[t],0,e[t]))}return[r,o,l]}testLoop(e,t,n,a=0,i){return wn((()=>{const s=this.checkNumSamples(t,n,i,"steps"),r=[];if(a>0)throw new sl("Verbose mode is not implemented yet.");if(null!=i)throw new sl("steps mode in testLoop() is not implemented yet");{const a=Ap(s,n),i=pr(Jl(0,s));for(let n=0;n<a.length;++n){const s=a[n][0],o=a[n][1],l=ec(i,s,o-s),c=$p(t,l),u=e(c);if(0===n)for(let e=0;e<u.length;++e)r.push(Di(0));for(let e=0;e<u.length;++e){const t=u[e];r[e]=xa(r[e],Ta(o-s,t))}}for(let e=0;e<r.length;++e)r[e]=Na(r[e],s)}return r}))}getDedupedMetricsNames(){const e=this.metricsNames,t=[];for(let n=0;n<e.length;++n){const a=e[n];let i=a;if(ul(e,a)>1){i+=`_${ul(e.slice(0,n),a)}`}t.push(i)}return t}makeTrainFunction(){return e=>{const t=[],n=e.slice(0,this.inputs.length),a=e.slice(this.inputs.length,this.inputs.length+this.outputs.length),i=e.slice(this.inputs.length+this.outputs.length,this.inputs.length+2*this.outputs.length),s=[],r=this.collectedTrainableWeights.map((e=>e.read()));return[this.optimizer_.minimize((()=>{const e=[];for(let t=0;t<this.inputs.length;++t)e.push({key:this.inputs[t],value:n[t]});const r=new Xc(e),o=nu(this.outputs,r,{training:!0});let l;for(let e=0;e<this.lossFunctions.length;++e){let n=(0,this.lossFunctions[e])(a[e],o[e]);null!=i[e]&&(n=kp(n,i[e]));const s=ls(n);t.push(s),l=0===e?n:xa(l,n)}for(let e=0;e<this.metricsTensors.length;++e){let n;if(this.outputs.length>1&&e<this.outputs.length)n=t[e];else{const t=this.metricsTensors[e][0],i=this.metricsTensors[e][1];n=ls(t(a[i],o[i]))}xn(n),s.push(n)}return l=ls(l),this.calculateLosses().forEach((e=>{l=xa(l,e)})),l}),!0,r)].concat(s)}}makeTestFunction(){this.testFunction=e=>wn((()=>{const t=[];let n;const a=e.slice(0,this.inputs.length),i=e.slice(this.inputs.length,this.inputs.length+this.outputs.length),s=[];for(let e=0;e<this.inputs.length;++e)s.push({key:this.inputs[e],value:a[e]});const r=new Xc(s),o=nu(this.outputs,r);for(let e=0;e<this.lossFunctions.length;++e){const a=this.lossFunctions[e],s=ls(a(i[e],o[e]));n=0===e?s:xa(n,s),t.push(n)}for(let e=0;e<this.metricsTensors.length;++e){const n=this.metricsTensors[e][0],a=this.metricsTensors[e][1],s=ls(n(i[a],o[a]));t.push(s)}return t}))}async fit(e,t,n={}){if(this.isTraining)throw new Error("Cannot start training because another fit() call is ongoing.");let a,i,s,r,o,l,c,u,h;this.isTraining=!0;try{const p=null==n.batchSize?32:n.batchSize;Ip(p);const d=!1,f=await this.standardizeUserData(e,t,n.sampleWeight,n.classWeight,d,p);a=f[0],i=f[1],h=f[2];let m,g=!1;if(null!=n.validationData&&n.validationData.length>0){if(g=!0,2!==n.validationData.length)throw 3===n.validationData.length?new sl("validationData including sample weights is not supported yet."):new il(`When passing validation data, it must contain 2 (valX, valY) or 3 (valX, valY, valSampleWeight) items; ${n.validationData} is invalid.`);o=n.validationData[0],l=n.validationData[1];const e=!0,t=await this.standardizeUserData(o,l,null,null,e,p);c=t[0],u=t[1],m=c.concat(u)}else if(null!=n.validationSplit&&n.validationSplit>0&&n.validationSplit<1){g=!0;const e=Math.floor(a[0].shape[0]*(1-n.validationSplit)),t=a[0].shape[0];c=Cp(a,e,t),s=a,a=Cp(a,0,e),u=Cp(i,e,t),r=i,i=Cp(i,0,e),m=c.concat(u)}else null!=n.validationSteps&&(g=!0);const v=a.concat(i).concat(h);this.checkTrainableWeightsConsistency();const y=this.makeTrainFunction(),b=this.getDedupedMetricsNames();let w,k;g?(this.makeTestFunction(),w=this.testFunction,k=b.slice().concat(b.map((e=>"val_"+e)))):(w=null,m=[],k=b.slice());const x=Mh(n.callbacks,n.yieldEvery);return await this.fitLoop(y,v,b,p,n.epochs,n.verbose,x,w,m,n.shuffle,k,n.initialEpoch,null,null)}finally{this.isTraining=!1,jp(a,e),jp(i,t),jp(s,e),jp(r,t),jp(c,o),jp(u,l),null!=h&&kn(h)}}async fitLoop(e,t,n,a,i,s,r,o,l,c,u,h,p,d){null==a&&(a=32),null==i&&(i=1),null==c&&(c=!0),null==h&&(h=0);let f=!1;if(null!=o&&null!=l&&(f=!0),null!=d&&(f=!0,null==p))throw new il("Can only use `validationSteps` when doing step-wise training, i.e., `stepsPerEpoch` must be set.");const m=this.checkNumSamples(t,a,p,"steps_per_epoch");let g;null!=m&&(g=Jl(0,m)),null==s&&(s=1);const{callbackList:v,history:y}=Ph(r,s,i,h,m,p,a,f,u);v.setModel(this),this.history=y,await v.onTrainBegin(),this.stopTraining_=!1;for(let s=h;s<i;++s){await v.onEpochBegin(s);const i={};if(null!=p)throw new sl("stepsPerEpoch mode is not implemented yet.");{if("batch"===c)throw new sl("batch shuffling is not implemneted yet");c&&w(g);const s=pr(g),r=Ap(m,a);for(let c=0;c<r.length;++c){const u={};if(await v.onBatchBegin(c,u),wn((()=>{const h=r[c][0],p=r[c][1],d=ec(s,h,p-h);u.batch=c,u.size=p-h;const m=$p(t,d),g=e(m);for(let e=0;e<n.length;++e){const t=n[e],a=g[e];u[t]=a,xn(a)}if(c===r.length-1&&f){const e=this.testLoop(o,l,a);for(let t=0;t<n.length;++t){const a=n[t],s=e[t];xn(s),i["val_"+a]=s}}})),await v.onBatchEnd(c,u),jh(u),this.stopTraining_)break}s.dispose()}if(await v.onEpochEnd(s,i),this.stopTraining_)break}return await v.onTrainEnd(),await this.history.syncData(),this.history}async fitDataset(e,t){return Np(this,e,t)}async trainOnBatch(e,t){const n=await this.standardizeUserData(e,t),a=n[0],i=n[1],s=this.makeTrainFunction()(a.concat(i)),r=[];for(const e of s){const t=await e.data();r.push(t[0])}return kn(s),jp(n[0],e),jp(n[1],t),hl(r)}getNamedWeights(e){const t=[],n=null!=e&&e.trainableOnly,a=n?this.trainableWeights:this.weights,i=this.getWeights(n);for(let e=0;e<a.length;++e)n&&!a[e].trainable||t.push({name:a[e].originalName,tensor:i[e]});return t}set stopTraining(e){this.stopTraining_=e}get stopTraining(){return this.stopTraining_}get optimizer(){return this.optimizer_}set optimizer(e){this.optimizer_!==e&&(this.optimizer_=e,this.isOptimizerOwned=!1)}dispose(){const e=super.dispose();if(0===e.refCountAfterDispose&&null!=this.optimizer&&this.isOptimizerOwned){const t=bn().numTensors;this.optimizer_.dispose(),e.numDisposedVariables+=t-bn().numTensors}return e}getLossIdentifiers(){let e;if("string"==typeof this.loss)e=dl(this.loss);else if(Array.isArray(this.loss)){for(const e of this.loss)if("string"!=typeof e)throw new Error("Serialization of non-string loss is not supported.");e=this.loss.map((e=>dl(e)))}else{const t=Object.keys(this.loss);e={};const n=this.loss;for(const a of t){if("string"!=typeof n[a])throw new Error("Serialization of non-string loss is not supported.");e[a]=dl(n[a])}}return e}getMetricIdentifiers(){if("string"==typeof this.metrics||"function"==typeof this.metrics)return[dl(rp(this.metrics))];if(Array.isArray(this.metrics))return this.metrics.map((e=>dl(rp(e))));{const e={};for(const t in this.metrics)e[t]=dl(rp(this.metrics[t]));return e}}getTrainingConfig(){return{loss:this.getLossIdentifiers(),metrics:this.getMetricIdentifiers(),optimizer_config:{class_name:this.optimizer.getClassName(),config:this.optimizer.getConfig()}}}loadTrainingConfig(e){if(null!=e.weighted_metrics)throw new Error("Loading weight_metrics is not supported yet.");if(null!=e.loss_weights)throw new Error("Loading loss_weights is not supported yet.");if(null!=e.sample_weight_mode)throw new Error("Loading sample_weight_mode is not supported yet.");const t=Bh(mp(e.optimizer_config));let n,a;if("string"==typeof e.loss)n=fl(e.loss);else if(Array.isArray(e.loss))n=e.loss.map((e=>fl(e)));else if(null!=e.loss){n={};for(const t in e.loss)n[t]=fl(e.loss[t])}if(Array.isArray(e.metrics))a=e.metrics.map((e=>fl(e)));else if(null!=e.metrics){a={};for(const t in e.metrics)a[t]=fl(e.metrics[t])}this.compile({loss:n,metrics:a,optimizer:t})}async save(e,t){if("string"==typeof e){const t=(n=e,zn.getSaveHandlers(n));if(0===t.length)throw new il(`Cannot find any save handlers for URL '${e}'`);if(t.length>1)throw new il(`Found more than one (${t.length}) save handlers for URL '${e}'`);e=t[0]}var n;if(null==e.save)throw new il("LayersModel.save() cannot proceed because the IOHandler provided does not have the `save` attribute defined.");const a=await Sn(this.getNamedWeights(t)),i={modelTopology:this.toJSON(null,!1),format:"layers-model",generatedBy:`TensorFlow.js tfjs-layers v${vp}`,convertedBy:null};if(null!=t&&t.includeOptimizer&&null!=this.optimizer){i.trainingConfig=this.getTrainingConfig();const e="optimizer",{data:t,specs:n}=await Sn(await this.optimizer.getWeights(),e);a.specs.push(...n),a.data=(s=[a.data,t],vn.join(s))}var s;if(null!=this.userDefinedMetadata){const e=!0;lp(this.userDefinedMetadata,this.name,e),i.userDefinedMetadata=this.userDefinedMetadata}return i.weightData=a.data,i.weightSpecs=a.specs,e.save(i)}setUserDefinedMetadata(e){lp(e,this.name),this.userDefinedMetadata=e}getUserDefinedMetadata(){return this.userDefinedMetadata}}Rp.className="Model",ka(Rp);class Lp extends Rp{}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
async function Mp(e,t){if(null==t&&(t={}),"string"==typeof e){const i=(n=e,a=t,zn.getLoadHandlers(n,a));if(0===i.length)i.push(function(e,t){return ia(e,t)}
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(e,t));else if(i.length>1)throw new il(`Found more than one (${i.length}) load handlers for URL '${e}'`);e=i[0]}var n,a;
/**
     * @license
     * Copyright 2018 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */return async function(e,t,n){null==n&&(n={});if(null==e.load)throw new il("Cannot proceed with model loading because the IOHandler provided does not have the `load` method implemented.");const a=await e.load();let i=a.modelTopology;null!=i.model_config&&(i=i.model_config);const s=null==n.strict||n.strict,r=null!=a.weightData&&null!=a.weightSpecs&&s,o=Bh(mp(i),t,r),l=a.trainingConfig;null!=l&&o.loadTrainingConfig(l);null!=a.userDefinedMetadata&&o.setUserDefinedMetadata(a.userDefinedMetadata);if(null!=a.weightData){if(null==a.weightSpecs)throw new il("LayersModel artifacts contains weight data, but not weight specs. Therefore loading of weights cannot proceed.");const{modelWeights:e,optimizerWeights:t}=function(e,t){const n=function(e,t){const n=new vn(e),a={};let i=0;for(const e of t){const t=Nn(e,((e,t)=>n.slice(i+e,i+t)));a[e.name]=Tn(e,n.slice(i,i+t)),i+=t}return a}(e,t),a={},i=[];return t.forEach((e=>{"optimizer"===e.group?i.push({name:e.name,tensor:n[e.name]}):a[e.name]=n[e.name]})),{modelWeights:a,optimizerWeights:i}}(a.weightData,a.weightSpecs);o.loadWeights(e,s),null!=o.optimizer&&t.length>0&&await o.optimizer.setWeights(t),kn(e),kn(t.map((e=>e.tensor)))}return o}(e,void 0,t)}Lp.className="Functional",ka(Lp);class Op extends Rp{constructor(e){if(super({inputs:[],outputs:[]}),e=e||{},this.trainable=!0,this.built=!1,this.name=null!=e.name?e.name:El("sequential_"),null!=e.layers)for(const t of e.layers)this.add(t)}checkShape(e){if(e.inboundNodes[0].outputTensors[0].shape.some((e=>e<0)))throw new il(`Negative dimension size caused by adding layer ${e.name} with input shape [${e.inboundNodes[0].inputTensors[0].shape}]`)}add(e){const t=e instanceof Op||e instanceof Rp;let n;if(t){if(n=e,1!==n.outputs.length)throw new il("All layers in a Sequential model should have a single output tensor. For multi-output layers, use the functional API.");if(1!==n.inputs.length)throw new il("All layers in a Sequential model should have a single input tensor. For multi-input layers, use the functional API.")}if(0===this.outputs.length){if(0===e.inboundNodes.length){if(null==e.batchInputShape)throw new il("The first layer in a Sequential model must get an `inputShape` or `batchInputShape` argument.");const t=function(e){if(null==e.batchShape&&null==e.shape)throw new Error("Please provide to Input either a `shape` or a `batchShape` argument. Note that `shape` does not include the batch dimension.");if(null!=e.batchShape&&null!=e.shape)throw new il("Please provide either a `shape` or `batchShape` argument to Input, but not both.");let t=e.batchShape;null!=e.shape&&null==t&&(t=[null].concat(e.shape));let n=e.dtype;return null==n&&(n="float32"),new Qc({batchInputShape:t,name:e.name,dtype:n,sparse:e.sparse}).inboundNodes[0].outputTensors[0]}({batchShape:e.batchInputShape,dtype:e.dtype,name:e.name+"_input"});e.apply(t)}if(t)this.outputs=n.outputs,this.inputs=n.inputs;else{if(1!==e.inboundNodes.length)throw new il(`A layer added to a Sequential model must not already be connected somewhere else. LayersModel received layer ${e.name} which has ${e.inboundNodes.length} pre-existing inbound connections.`);if(1!==e.inboundNodes[0].outputTensors.length)throw new il("All layers in a Sequential model should have a single output tensor. For multi-output layers, use the functional API.");this.checkShape(e),this.outputs=[e.inboundNodes[0].outputTensors[0]],this.inputs=Yc(this.outputs[0])}this.inboundNodes=[],new Hc({outboundLayer:this,inboundLayers:[],nodeIndices:[],tensorIndices:[],inputTensors:this.inputs,outputTensors:this.outputs,inputMasks:ll(null,this.inputs.length),outputMasks:[null],inputShapes:this.inputs.map((e=>e.shape)),outputShapes:this.outputs[0].shape})}else{const t=e.apply(this.outputs[0]);if(Array.isArray(t))throw new TypeError("All layers in a Sequential model should have a single output tensor. For multi-output layers, use the functional API.");this.checkShape(e),this.outputs=[t],this.inboundNodes[0].outputTensors=this.outputs,this.inboundNodes[0].outputShapes=[this.outputs[0].shape]}this.layers.push(e),this.built=!1}pop(){if(0===this.layers.length)throw new TypeError("There are no layers in the model.");if(this.layers.pop(),0===this.layers.length)this.outputs=[],this.inboundNodes=[],this.outboundNodes=[];else{const e=this.layers.length-1;this.layers[e].outboundNodes=[],this.outputs=[this.layers[e].output],this.inboundNodes[0].outputTensors=this.outputs,this.inboundNodes[0].outputShapes=[this.outputs[0].shape]}}call(e,t){return null==this.model&&this.build(),this.model.call(e,t)}build(e){if(Oc(e),0===this.inputs.length||0===this.outputs.length)throw new TypeError("Sequential model cannot be built: model is empty. Add some layers first.");this.model=new Rp({inputs:this.inputs,outputs:this.outputs[0],name:this.name+"_model"}),this.model.trainable=this.trainable,this.supportsMasking=this.model.supportsMasking,this.inputLayers=this.model.inputLayers,this.inputLayersNodeIndices=this.model.inputLayersNodeIndices,this.inputLayersTensorIndices=this.model.inputLayersTensorIndices,this.outputLayers=this.model.outputLayers,this.outputLayersNodeIndices=this.model.outputLayersNodeIndices,this.outputLayersTensorIndices=this.model.outputLayersTensorIndices,this.nodesByDepth=this.model.nodesByDepth,this.containerNodes=this.model.containerNodes,this.outputNames=this.model.outputNames,this.inputNames=this.model.inputNames,this.built=!0}countParams(){return this.built||this.build(),super.countParams()}summary(e,t,n=console.log){this.built||this.build(),super.summary(e,t,n)}setWeights(e){null==this.model&&this.build(),this.model.setWeights(e)}evaluate(e,t,n={}){if(!this.built)throw new al("The model needs to be compiled before being used.");return this.model.evaluate(e,t,n)}async evaluateDataset(e,t){if(!this.built)throw new al("The model needs to be compiled before being used.");return this.model.evaluateDataset(e,t)}predict(e,t={}){return null==this.model&&this.build(),this.model.predict(e,t)}predictOnBatch(e){return null==this.model&&this.build(),this.model.predictOnBatch(e)}compile(e){this.build(),this.model.compile(e),this.optimizer_=this.model.optimizer,this.isOptimizerOwned=this.model.isOptimizerOwned,this.loss=this.model.loss,this.metrics=this.model.metrics,this.metricsTensors=this.model.metricsTensors,this.metricsNames=this.model.metricsNames}get optimizer(){return null==this.model?void 0:this.model.optimizer}set optimizer(e){this.model.optimizer=e}async fit(e,t,n={}){if(!this.built)throw new al("The model needs to be compiled before being used.");return this.model.fit(e,t,n)}async fitDataset(e,t){if(!this.built)throw new al("The model needs to be compiled before being used.");return this.model.fitDataset(e,t)}async trainOnBatch(e,t){return this.model.trainOnBatch(e,t)}static fromConfig(e,t,n={},a=!1){let i,s={};if(t instanceof Array){if(null==t[0].className||"Merge"===t[0].className)throw new il("Legacy serialization format not supported yet.");i=t}else x(null!=t.layers,(()=>"When the config data for a Sequential model is not an Array, it must be an Object that contains the 'layers' field.")),i=t.layers,delete t.layers,s=t;const r=new e(s);if(!(r instanceof Op))throw new sl(`Sequential.fromConfig called on non-Sequential input: ${r}`);for(const e of i){const t=Bh(e,void 0,a);a&&t.setFastWeightInitDuringBuild(!0),r.add(t)}return r}set stopTraining(e){if(null==this.model)throw new il("Cannot set the stopTraining property of a sequential model before it is compiled.");this.model.stopTraining=e}get stopTraining(){if(null==this.model)throw new il("Cannot get the stopTraining property of a sequential model before it is compiled.");return this.model.stopTraining}getConfig(){const e=[];for(const t of this.layers){const n={};n.className=t.getClassName(),n.config=t.getConfig(),e.push(n)}return{name:this.name,layers:e}}}Op.className="Sequential",ka(Op);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
let Pp=class extends ba{getConfig(){return{}}};class Bp extends Pp{apply(e,t=1){return function(e,t=1){if(1!==t)throw new sl(`Support for alpha values other than 1 (${t}) is not implemented yet.`);return Si(e)}(e,t)}}Bp.className="elu",ka(Bp);class Up extends Pp{apply(e){return Xs(e)}}Up.className="selu",ka(Up);class Wp extends Pp{apply(e){return Hs(e)}}Wp.className="relu",ka(Wp);class Gp extends Pp{apply(e){return wn((()=>hs(6,Hs(e))))}}Gp.className="relu6",ka(Gp);class Vp extends Pp{apply(e){return e}}Vp.className="linear",ka(Vp);class Kp extends Pp{apply(e){return Wa(e)}}Kp.className="sigmoid",ka(Kp);class qp extends Pp{apply(e){return function(e){return wn((()=>{const t=xa(.5,Ta(.2,e));return ti(t,0,1)}))}(e)}}qp.className="hardSigmoid",ka(qp);class Hp extends Pp{apply(e){return Xi(e)}}Hp.className="softplus",ka(Hp);class Jp extends Pp{apply(e){return function(e){return wn((()=>Na(e,xa(Ia(e),1))))}(e)}}Jp.className="softsign",ka(Jp);class Zp extends Pp{apply(e){return Va(e)}}Zp.className="tanh",ka(Zp);let Yp=class extends Pp{apply(e,t=-1){return or(e,t)}};Yp.className="softmax",ka(Yp);class Qp extends Pp{apply(e,t=-1){return ts(e,t)}}Qp.className="logSoftmax",ka(Qp);class Xp extends Pp{apply(e){return wn((()=>wn((()=>{const t=Math.sqrt(2),n=Ta(.5,xa(1,Ni(Na(e,t))));return Ta(e,n)}))))}}Xp.className="gelu",ka(Xp);class ed extends Pp{apply(e){return wn((()=>Ta(.5,Ta(e,xa(1,Va(Ta(Fi(Na(2,Math.PI)),xa(e,Ta(.044715,zi(e,3))))))))))}}ed.className="gelu_new",ka(ed);class td extends Pp{apply(e){return wn((()=>Ta(e,Va(Xi(e)))))}}td.className="mish",ka(td);class nd extends Pp{apply(e,t=1){return wn((()=>Ta(Wa(Ta(e,t)),e)))}}function ad(e){return e.getClassName()}function id(e,t={}){return yl(e,wa.getMap().classNameMap,t,"activation")}function sd(e){if(null==e){const e={className:"linear",config:{}};return id(e)}if("string"==typeof e){const t={};return t.className=e,t.config={},id(t)}return e instanceof Pp?e:id(e)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */nd.className="swish",ka(nd);class rd extends ba{}class od extends rd{constructor(e){super(),function(e){if(null!=e&&"object"!=typeof e)throw new Error(`Argument to L1L2 regularizer's constructor is expected to be an object, but received: ${e}`)}(e),this.l1=null==e||null==e.l1?.01:e.l1,this.l2=null==e||null==e.l2?.01:e.l2,this.hasL1=0!==this.l1,this.hasL2=0!==this.l2}apply(e){return wn((()=>{let t=cs([1]);return this.hasL1&&(t=xa(t,Ri(Ta(this.l1,Ia(e))))),this.hasL2&&(t=xa(t,Ri(Ta(this.l2,cc(e))))),Ma(t,[])}))}getConfig(){return{l1:this.l1,l2:this.l2}}static fromConfig(e,t){return new e({l1:t.l1,l2:t.l2})}}od.className="L1L2",ka(od);const ld={l1l2:"L1L2"};function cd(e){return gl(e)}function ud(e,t={}){return yl(e,wa.getMap().classNameMap,t,"regularizer")}function hd(e){if(null==e)return null;if("string"==typeof e){return ud({className:e in ld?ld[e]:e,config:{}})}return e instanceof rd?e:ud(e)}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */class pd extends Zc{constructor(e){super(null==e?{}:e),this.supportsMasking=!0,null!=e&&(this.maxValue=e.maxValue)}call(e,t){e=Mc(e);let n=Hs(e);return null!=this.maxValue&&(n=ti(n,0,this.maxValue)),n}computeOutputShape(e){return e}getConfig(){const e={maxValue:this.maxValue},t=super.getConfig();return Object.assign(e,t),e}}pd.className="ReLU",ka(pd);class dd extends Zc{constructor(e){super(null==e?{}:e),this.DEFAULT_ALPHA=.3,null==e&&(e={}),this.alpha=null==e.alpha?this.DEFAULT_ALPHA:e.alpha}call(e,t){const n=Mc(e);return qi(n,this.alpha)}computeOutputShape(e){return e}getConfig(){const e={alpha:this.alpha},t=super.getConfig();return Object.assign(e,t),e}}dd.className="LeakyReLU",ka(dd);class fd extends Zc{constructor(e){if(super(null==e?{}:e),this.DEFAULT_ALPHA_INITIALIZER="zeros",null==e&&(e={}),this.supportsMasking=!0,this.alphaInitializer=_c(e.alphaInitializer||this.DEFAULT_ALPHA_INITIALIZER),this.alphaRegularizer=hd(e.alphaRegularizer),this.alphaConstraint=Ah(e.alphaConstraint),null==e.sharedAxes)this.sharedAxes=null;else if(Array.isArray(e.sharedAxes))this.sharedAxes=e.sharedAxes;else{if("number"!=typeof e.sharedAxes)throw new il(`Expected sharedAxes to be a number or an array of numbers, but got ${e.sharedAxes}`);this.sharedAxes=[e.sharedAxes]}}build(e){const t=(e=Oc(e)).slice(1);if(null!=this.sharedAxes)for(const e of this.sharedAxes)t[e-1]=1;this.alpha=this.addWeight("alpha",t,"float32",this.alphaInitializer,this.alphaRegularizer,!0,this.alphaConstraint);const n={};if(null!=this.sharedAxes)for(let t=1;t<e.length;++t)n[t]=e[t];this.inputSpec=[new Vc({ndim:e.length,axes:n})],this.built=!0}call(e,t){return e=Mc(e),vs(e,this.alpha.read())}getConfig(){const e={alphaInitializer:Fc(this.alphaInitializer),alphaRegularizer:cd(this.alphaRegularizer),alphaConstraint:Ch(this.alphaConstraint),sharedAxes:this.sharedAxes},t=super.getConfig();return Object.assign(e,t),e}}fd.className="PReLU",ka(fd);class md extends Zc{constructor(e){if(super(null==e?{}:e),this.DEFAULT_ALPHA=1,null==e&&(e={}),null!=e.alpha&&e.alpha!==this.DEFAULT_ALPHA)throw new sl(`Non-default alpha value (${e.alpha}) is not supported by the ELU layer yet.`);this.alpha=null==e.alpha?this.DEFAULT_ALPHA:e.alpha}call(e,t){const n=Mc(e);return Si(n)}computeOutputShape(e){return e}getConfig(){const e={alpha:this.alpha},t=super.getConfig();return Object.assign(e,t),e}}md.className="ELU",ka(md);class gd extends Zc{constructor(e){super(null==e?{}:e),this.DEFAULT_THETA=1,null==e&&(e={}),this.theta=null==e.theta?this.DEFAULT_THETA:e.theta}call(e,t){const n=Mc(e);return Ta(n,ra(Vi(n,this.theta),"float32"))}computeOutputShape(e){return e}getConfig(){const e={theta:this.theta},t=super.getConfig();return Object.assign(e,t),e}}gd.className="ThresholdedReLU",ka(gd);class vd extends Zc{constructor(e){super(null==e?{}:e),this.DEFAULT_AXIS=1,null==e&&(e={}),this.softmax=(new Yp).apply,this.axis=null==e.axis?this.DEFAULT_AXIS:e.axis}call(e,t){return wn((()=>{let n=Mc(e);const a=t.mask;if(null!=a){const e=Ta(es(us(n.shape),ra(a,n.dtype)),Di(-1e9));n=xa(n,e)}return this.axis instanceof Array?this.axis.length>1?Oi(es(n,ns(n,this.axis,!0))):this.softmax(n,this.axis[0]):this.softmax(n,this.axis)}))}computeOutputShape(e){return e}getConfig(){const e={axis:this.axis},t=super.getConfig();return Object.assign(e,t),e}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function yd(e,t,n){if("number"==typeof e)return ll(e,t);if(e.length!==t)throw new il(`The ${n} argument must be an integer or tuple of ${t} integers. Received: ${e.length} elements.`);for(let i=0;i<t;++i){const s=e[i];if((a=s)!==parseInt(a.toString(),10))throw new il(`The ${n} argument must be an integer or tuple of ${t} integers. Received: ${JSON.stringify(e)} including a non-integer number ${s}`)}return e;var a}function bd(e,t,n,a,i=1){if(null==e)return e;let s;return s="same"===n?e:e-(t+(t-1)*(i-1))+1,Math.floor((s+a-1)/a)}function wd(e,t,n,a){if(null==e)return null;if("valid"===a)e=e*t+Hl([n-t,0]);else{if("same"!==a)throw new il(`Unsupport padding mode: ${a}.`);e*=t}return e}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */function kd(e,t){return wn((()=>(Ll(t),"channelsFirst"===t?pa(e,[0,2,3,1]):e)))}function xd(e,t){return wn((()=>(Ll(t),"channelsFirst"===t?pa(e,[0,2,3,4,1]):e)))}function Sd(e,t,n,a=[1,1],i="valid",s,r,o=null){return wn((()=>{if(null==s&&(s="channelsLast"),Ll(s),3!==e.rank&&4!==e.rank)throw new il(`conv2dWithBiasActivation expects input to be of rank 3 or 4, but received ${e.rank}.`);if(3!==t.rank&&4!==t.rank)throw new il(`conv2dWithBiasActivation expects kernel to be of rank 3 or 4, but received ${e.rank}.`);let l=kd(e,s);if("causal"===i)throw new sl("The support for CAUSAL padding mode in conv1dWithBias is not implemented yet.");return l=Sr({x:l,filter:t,strides:a,pad:"same"===i?"same":"valid",dilations:r,dataFormat:"NHWC",bias:n,activation:o}),"channelsFirst"===s&&(l=pa(l,[0,3,1,2])),l}))}vd.className="Softmax",ka(vd);class Nd extends Zc{constructor(e,t){if(super(t),this.bias=null,this.DEFAULT_KERNEL_INITIALIZER="glorotNormal",this.DEFAULT_BIAS_INITIALIZER="zeros",Nd.verifyArgs(t),this.rank=e,Nl(this.rank,"rank"),1!==this.rank&&2!==this.rank&&3!==this.rank)throw new sl(`Convolution layer for rank other than 1, 2, or 3 (${this.rank}) is not implemented yet.`);if(this.kernelSize=yd(t.kernelSize,e,"kernelSize"),this.strides=yd(null==t.strides?1:t.strides,e,"strides"),this.padding=null==t.padding?"valid":t.padding,Ml(this.padding),this.dataFormat=null==t.dataFormat?"channelsLast":t.dataFormat,Ll(this.dataFormat),this.activation=sd(t.activation),this.useBias=null==t.useBias||t.useBias,this.biasInitializer=_c(t.biasInitializer||this.DEFAULT_BIAS_INITIALIZER),this.biasConstraint=Ah(t.biasConstraint),this.biasRegularizer=hd(t.biasRegularizer),this.activityRegularizer=hd(t.activityRegularizer),this.dilationRate=yd(null==t.dilationRate?1:t.dilationRate,e,"dilationRate"),1===this.rank&&Array.isArray(this.dilationRate)&&1!==this.dilationRate.length)throw new il(`dilationRate must be a number or an array of a single number for 1D convolution, but received ${JSON.stringify(this.dilationRate)}`);if(2===this.rank){if("number"==typeof this.dilationRate)this.dilationRate=[this.dilationRate,this.dilationRate];else if(2!==this.dilationRate.length)throw new il(`dilationRate must be a number or array of two numbers for 2D convolution, but received ${JSON.stringify(this.dilationRate)}`)}else if(3===this.rank)if("number"==typeof this.dilationRate)this.dilationRate=[this.dilationRate,this.dilationRate,this.dilationRate];else if(3!==this.dilationRate.length)throw new il(`dilationRate must be a number or array of three numbers for 3D convolution, but received ${JSON.stringify(this.dilationRate)}`)}static verifyArgs(e){if(cl("kernelSize"in e,"required key 'kernelSize' not in config"),"number"!=typeof e.kernelSize&&!Sl(e.kernelSize,"number",1,3))throw new il(`BaseConv expects config.kernelSize to be number or number[] with length 1, 2, or 3, but received ${JSON.stringify(e.kernelSize)}.`)}getConfig(){const e={kernelSize:this.kernelSize,strides:this.strides,padding:this.padding,dataFormat:this.dataFormat,dilationRate:this.dilationRate,activation:ad(this.activation),useBias:this.useBias,biasInitializer:Fc(this.biasInitializer),biasRegularizer:cd(this.biasRegularizer),activityRegularizer:cd(this.activityRegularizer),biasConstraint:Ch(this.biasConstraint)},t=super.getConfig();return Object.assign(e,t),e}}class Td extends Nd{constructor(e,t){super(e,t),this.kernel=null,Td.verifyArgs(t),this.filters=t.filters,Nl(this.filters,"filters"),this.kernelInitializer=_c(t.kernelInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.kernelConstraint=Ah(t.kernelConstraint),this.kernelRegularizer=hd(t.kernelRegularizer)}build(e){e=Oc(e);const t="channelsFirst"===this.dataFormat?1:e.length-1;if(null==e[t])throw new il(`The channel dimension of the input should be defined. Found ${e[t]}`);const n=e[t],a=this.kernelSize.concat([n,this.filters]);this.kernel=this.addWeight("kernel",a,null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.useBias&&(this.bias=this.addWeight("bias",[this.filters],null,this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint)),this.inputSpec=[{ndim:this.rank+2,axes:{[t]:n}}],this.built=!0}call(e,t){return wn((()=>{let t;e=Mc(e);const n=null==this.bias?null:this.bias.read(),a=Il(this.activation.getClassName());if(null!=a&&2===this.rank)t=Sd(e,this.kernel.read(),n,this.strides,this.padding,this.dataFormat,this.dilationRate,a);else{if(1===this.rank)t=function(e,t,n,a=1,i="valid",s,r=1){return wn((()=>{if(null==s&&(s="channelsLast"),Ll(s),3!==e.shape.length)throw new il(`The input of a conv1dWithBias operation should be 3, but is ${e.shape.length} instead.`);if(3!==t.shape.length)throw new il(`The kernel for a conv1dWithBias operation should be 3, but is ${t.shape.length} instead`);if(null!=n&&1!==n.shape.length)throw new il(`The bias for a conv1dWithBias operation should be 1, but is ${n.shape.length} instead`);if("channelsFirst"===s&&(e=pa(e,[0,2,1])),"causal"===i)throw new sl("The support for CAUSAL padding mode in conv1dWithBias is not implemented yet.");let o=oi(e,t,a,"same"===i?"same":"valid","NWC",r);return null!=n&&(o=hc(o,n)),o}))}(e,this.kernel.read(),n,this.strides[0],this.padding,this.dataFormat,this.dilationRate[0]);else if(2===this.rank)t=Sd(e,this.kernel.read(),n,this.strides,this.padding,this.dataFormat,this.dilationRate);else{if(3!==this.rank)throw new sl("convolutions greater than 3D are not implemented yet.");t=function(e,t,n,a=[1,1,1],i="valid",s,r){return wn((()=>{if(null==s&&(s="channelsLast"),Ll(s),4!==e.rank&&5!==e.rank)throw new il(`conv3dWithBias expects input to be of rank 4 or 5, but received ${e.rank}.`);if(4!==t.rank&&5!==t.rank)throw new il(`conv3dWithBias expects kernel to be of rank 4 or 5, but received ${e.rank}.`);let o=xd(e,s);if("causal"===i)throw new sl("The support for CAUSAL padding mode in conv3dWithBias is not implemented yet.");return o=ui(o,t,a,"same"===i?"same":"valid","NDHWC",r),null!=n&&(o=hc(o,n)),"channelsFirst"===s&&(o=pa(o,[0,4,1,2,3])),o}))}(e,this.kernel.read(),n,this.strides,this.padding,this.dataFormat,this.dilationRate)}null!=this.activation&&(t=this.activation.apply(t))}return t}))}computeOutputShape(e){e=Oc(e);const t=[],n="channelsLast"===this.dataFormat?e.slice(1,e.length-1):e.slice(2);for(let e=0;e<n.length;++e){const a=bd(n[e],this.kernelSize[e],this.padding,this.strides[e],"number"==typeof this.dilationRate?this.dilationRate:this.dilationRate[e]);t.push(a)}let a=[e[0]];return"channelsLast"===this.dataFormat?(a=a.concat(t),a.push(this.filters)):(a.push(this.filters),a=a.concat(t)),a}getConfig(){const e={filters:this.filters,kernelInitializer:Fc(this.kernelInitializer),kernelRegularizer:cd(this.kernelRegularizer),kernelConstraint:Ch(this.kernelConstraint)},t=super.getConfig();return Object.assign(e,t),e}static verifyArgs(e){if(!("filters"in e)||"number"!=typeof e.filters||e.filters<1)throw new il(`Convolution layer expected config.filters to be a 'number' > 0 but got ${JSON.stringify(e.filters)}`)}}class Id extends Td{constructor(e){super(2,e),Id.verifyArgs(e)}getConfig(){const e=super.getConfig();return delete e.rank,e}static verifyArgs(e){if("number"!=typeof e.kernelSize&&!Sl(e.kernelSize,"number",1,2))throw new il(`Conv2D expects config.kernelSize to be number or number[] with length 1 or 2, but received ${JSON.stringify(e.kernelSize)}.`)}}Id.className="Conv2D",ka(Id);class Cd extends Td{constructor(e){super(3,e),Cd.verifyArgs(e)}getConfig(){const e=super.getConfig();return delete e.rank,e}static verifyArgs(e){if("number"!=typeof e.kernelSize&&(!Array.isArray(e.kernelSize)||1!==e.kernelSize.length&&3!==e.kernelSize.length))throw new il(`Conv3D expects config.kernelSize to be number or [number, number, number], but received ${JSON.stringify(e.kernelSize)}.`)}}Cd.className="Conv3D",ka(Cd);class $d extends Id{constructor(e){if(super(e),this.inputSpec=[new Vc({ndim:4})],"same"!==this.padding&&"valid"!==this.padding)throw new il(`Conv2DTranspose currently supports only padding modes 'same' and 'valid', but received padding mode ${this.padding}`)}build(e){if(4!==(e=Oc(e)).length)throw new il("Input should have rank 4; Received input shape: "+JSON.stringify(e));const t="channelsFirst"===this.dataFormat?1:e.length-1;if(null==e[t])throw new il("The channel dimension of the inputs should be defined. Found `None`.");const n=e[t],a=this.kernelSize.concat([this.filters,n]);this.kernel=this.addWeight("kernel",a,"float32",this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.useBias&&(this.bias=this.addWeight("bias",[this.filters],"float32",this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint)),this.inputSpec=[new Vc({ndim:4,axes:{[t]:n}})],this.built=!0}call(e,t){return wn((()=>{let t=Mc(e);if(4!==t.shape.length)throw new il(`Conv2DTranspose.call() expects input tensor to be rank-4, but received a tensor of rank-${t.shape.length}`);const n=t.shape,a=n[0];let i,s;"channelsFirst"===this.dataFormat?(i=2,s=3):(i=1,s=2);const r=n[i],o=n[s],l=this.kernelSize[0],c=this.kernelSize[1],u=this.strides[0],h=this.strides[1],p=[a,wd(r,u,l,this.padding),wd(o,h,c,this.padding),this.filters];"channelsLast"!==this.dataFormat&&(t=pa(t,[0,2,3,1]));let d=ci(t,this.kernel.read(),p,this.strides,this.padding);return"channelsLast"!==this.dataFormat&&(d=pa(d,[0,3,1,2])),null!=this.bias&&(d=hc(d,this.bias.read(),this.dataFormat)),null!=this.activation&&(d=this.activation.apply(d)),d}))}computeOutputShape(e){const t=(e=Oc(e)).slice();let n,a,i;"channelsFirst"===this.dataFormat?(n=1,a=2,i=3):(n=3,a=1,i=2);const s=this.kernelSize[0],r=this.kernelSize[1],o=this.strides[0],l=this.strides[1];return t[n]=this.filters,t[a]=wd(t[a],o,s,this.padding),t[i]=wd(t[i],l,r,this.padding),t}getConfig(){const e=super.getConfig();return delete e.dilationRate,e}}$d.className="Conv2DTranspose",ka($d);class Ad extends Cd{constructor(e){if(super(e),this.inputSpec=[new Vc({ndim:5})],"same"!==this.padding&&"valid"!==this.padding)throw new il(`Conv3DTranspose currently supports only padding modes 'same' and 'valid', but received padding mode ${this.padding}`)}build(e){if(5!==(e=Oc(e)).length)throw new il("Input should have rank 5; Received input shape: "+JSON.stringify(e));const t="channelsFirst"===this.dataFormat?1:e.length-1;if(null==e[t])throw new il("The channel dimension of the inputs should be defined. Found `None`.");const n=e[t],a=this.kernelSize.concat([this.filters,n]);this.kernel=this.addWeight("kernel",a,"float32",this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.useBias&&(this.bias=this.addWeight("bias",[this.filters],"float32",this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint)),this.inputSpec=[new Vc({ndim:5,axes:{[t]:n}})],this.built=!0}call(e,t){return wn((()=>{let t=Mc(e);if(5!==t.shape.length)throw new il(`Conv3DTranspose.call() expects input tensor to be rank-4, but received a tensor of rank-${t.shape.length}`);const n=t.shape,a=n[0];let i,s,r;"channelsFirst"===this.dataFormat?(r=2,i=3,s=4):(r=1,i=2,s=3);const o=n[r],l=n[i],c=n[s],u=this.kernelSize[0],h=this.kernelSize[1],p=this.kernelSize[2],d=this.strides[0],f=this.strides[1],m=this.strides[2],g=[a,wd(o,d,u,this.padding),wd(l,f,h,this.padding),wd(c,m,p,this.padding),this.filters];"channelsLast"!==this.dataFormat&&(t=pa(t,[0,2,3,4,1]));let v=pi(t,this.kernel.read(),g,this.strides,this.padding);return"channelsLast"!==this.dataFormat&&(v=pa(v,[0,4,1,2,3])),null!==this.bias&&(v=hc(v,this.bias.read(),this.dataFormat)),null!==this.activation&&(v=this.activation.apply(v)),v}))}computeOutputShape(e){const t=(e=Oc(e)).slice();let n,a,i,s;"channelsFirst"===this.dataFormat?(n=1,a=2,i=3,s=4):(n=4,a=1,i=2,s=3);const r=this.kernelSize[0],o=this.kernelSize[1],l=this.kernelSize[2],c=this.strides[0],u=this.strides[1],h=this.strides[2];return t[n]=this.filters,t[a]=wd(t[a],c,r,this.padding),t[i]=wd(t[i],u,o,this.padding),t[s]=wd(t[s],h,l,this.padding),t}getConfig(){const e=super.getConfig();return delete e.dilationRate,e}}Ad.className="Conv3DTranspose",ka(Ad);class Ed extends Td{constructor(e,t){if(super(e,t),this.DEFAULT_DEPTHWISE_INITIALIZER="glorotUniform",this.DEFAULT_POINTWISE_INITIALIZER="glorotUniform",this.depthwiseKernel=null,this.pointwiseKernel=null,null==t.filters)throw new il("The `filters` configuration field is required by SeparableConv, but is unspecified.");if(null!=t.kernelInitializer||null!=t.kernelRegularizer||null!=t.kernelConstraint)throw new il("Fields kernelInitializer, kernelRegularizer and kernelConstraint are invalid for SeparableConv2D. Use depthwiseInitializer, depthwiseRegularizer, depthwiseConstraint, pointwiseInitializer, pointwiseRegularizer and pointwiseConstraint instead.");if(null!=t.padding&&"same"!==t.padding&&"valid"!==t.padding)throw new il(`SeparableConv${this.rank}D supports only padding modes: 'same' and 'valid', but received ${JSON.stringify(t.padding)}`);this.depthMultiplier=null==t.depthMultiplier?1:t.depthMultiplier,this.depthwiseInitializer=_c(t.depthwiseInitializer||this.DEFAULT_DEPTHWISE_INITIALIZER),this.depthwiseRegularizer=hd(t.depthwiseRegularizer),this.depthwiseConstraint=Ah(t.depthwiseConstraint),this.pointwiseInitializer=_c(t.depthwiseInitializer||this.DEFAULT_POINTWISE_INITIALIZER),this.pointwiseRegularizer=hd(t.pointwiseRegularizer),this.pointwiseConstraint=Ah(t.pointwiseConstraint)}build(e){if((e=Oc(e)).length<this.rank+2)throw new il(`Inputs to SeparableConv${this.rank}D should have rank ${this.rank+2}, but received input shape: ${JSON.stringify(e)}`);const t="channelsFirst"===this.dataFormat?1:e.length-1;if(null==e[t]||e[t]<0)throw new il(`The channel dimension of the inputs should be defined, but found ${JSON.stringify(e[t])}`);const n=e[t],a=this.kernelSize.concat([n,this.depthMultiplier]),i=[];for(let e=0;e<this.rank;++e)i.push(1);i.push(n*this.depthMultiplier,this.filters);const s=!0;this.depthwiseKernel=this.addWeight("depthwise_kernel",a,"float32",this.depthwiseInitializer,this.depthwiseRegularizer,s,this.depthwiseConstraint),this.pointwiseKernel=this.addWeight("pointwise_kernel",i,"float32",this.pointwiseInitializer,this.pointwiseRegularizer,s,this.pointwiseConstraint),this.useBias?this.bias=this.addWeight("bias",[this.filters],"float32",this.biasInitializer,this.biasRegularizer,s,this.biasConstraint):this.bias=null,this.inputSpec=[new Vc({ndim:this.rank+2,axes:{[t]:n}})],this.built=!0}call(e,t){return wn((()=>{let t;if(e=Mc(e),1===this.rank)throw new sl("1D separable convolution is not implemented yet.");return 2===this.rank&&("channelsFirst"===this.dataFormat&&(e=pa(e,[0,2,3,1])),t=er(e,this.depthwiseKernel.read(),this.pointwiseKernel.read(),this.strides,this.padding,this.dilationRate,"NHWC")),this.useBias&&(t=hc(t,this.bias.read(),this.dataFormat)),null!=this.activation&&(t=this.activation.apply(t)),"channelsFirst"===this.dataFormat&&(t=pa(t,[0,3,1,2])),t}))}getConfig(){const e=super.getConfig();return delete e.rank,delete e.kernelInitializer,delete e.kernelRegularizer,delete e.kernelConstraint,e.depthwiseInitializer=Fc(this.depthwiseInitializer),e.pointwiseInitializer=Fc(this.pointwiseInitializer),e.depthwiseRegularizer=cd(this.depthwiseRegularizer),e.pointwiseRegularizer=cd(this.pointwiseRegularizer),e.depthwiseConstraint=Ch(this.depthwiseConstraint),e.pointwiseConstraint=Ch(this.pointwiseConstraint),e}}Ed.className="SeparableConv";class jd extends Ed{constructor(e){super(2,e)}}jd.className="SeparableConv2D",ka(jd);class zd extends Td{constructor(e){super(1,e),zd.verifyArgs(e),this.inputSpec=[{ndim:3}]}getConfig(){const e=super.getConfig();return delete e.rank,delete e.dataFormat,e}static verifyArgs(e){if("number"!=typeof e.kernelSize&&!Sl(e.kernelSize,"number",1,1))throw new il(`Conv1D expects config.kernelSize to be number or number[] with length 1, but received ${JSON.stringify(e.kernelSize)}.`)}}zd.className="Conv1D",ka(zd);class Dd extends Zc{constructor(e){super(e),"number"==typeof e.cropping?this.cropping=[[e.cropping,e.cropping],[e.cropping,e.cropping]]:"number"==typeof e.cropping[0]?this.cropping=[[e.cropping[0],e.cropping[0]],[e.cropping[1],e.cropping[1]]]:this.cropping=e.cropping,this.dataFormat=void 0===e.dataFormat?"channelsLast":e.dataFormat,this.inputSpec=[{ndim:4}]}computeOutputShape(e){return"channelsFirst"===this.dataFormat?[e[0],e[1],e[2]-this.cropping[0][0]-this.cropping[0][1],e[3]-this.cropping[1][0]-this.cropping[1][1]]:[e[0],e[1]-this.cropping[0][0]-this.cropping[0][1],e[2]-this.cropping[1][0]-this.cropping[1][1],e[3]]}call(e,t){return wn((()=>{if(e=Mc(e),"channelsLast"===this.dataFormat){const t=nc(e,this.cropping[0][0],e.shape[1]-this.cropping[0][0]-this.cropping[0][1],2);return nc(t,this.cropping[1][0],e.shape[2]-this.cropping[1][1]-this.cropping[1][0],3)}{const t=nc(e,this.cropping[0][0],e.shape[2]-this.cropping[0][0]-this.cropping[0][1],3);return nc(t,this.cropping[1][0],e.shape[3]-this.cropping[1][1]-this.cropping[1][0],4)}}))}getConfig(){const e={cropping:this.cropping,dataFormat:this.dataFormat},t=super.getConfig();return Object.assign(e,t),e}}Dd.className="Cropping2D",ka(Dd);class Fd extends Zc{constructor(e){var t;super(e),this.DEFAULT_SIZE=[2,2],this.inputSpec=[{ndim:4}],this.size=null==e.size?this.DEFAULT_SIZE:e.size,this.dataFormat=null==e.dataFormat?"channelsLast":e.dataFormat,Ll(this.dataFormat),this.interpolation=null==e.interpolation?"nearest":e.interpolation,t=this.interpolation,xl(zl,"InterpolationFormat",t)}computeOutputShape(e){if("channelsFirst"===this.dataFormat){const t=null==e[2]?null:this.size[0]*e[2],n=null==e[3]?null:this.size[1]*e[3];return[e[0],e[1],t,n]}{const t=null==e[1]?null:this.size[0]*e[1],n=null==e[2]?null:this.size[1]*e[2];return[e[0],t,n,e[3]]}}call(e,t){return wn((()=>{let t=Mc(e);const n=t.shape;if("channelsFirst"===this.dataFormat){t=pa(t,[0,2,3,1]);const e=this.size[0]*n[2],a=this.size[1]*n[3],i="nearest"===this.interpolation?Zr.resizeNearestNeighbor(t,[e,a]):Zr.resizeBilinear(t,[e,a]);return pa(i,[0,3,1,2])}{const e=this.size[0]*n[1],a=this.size[1]*n[2];return"nearest"===this.interpolation?Zr.resizeNearestNeighbor(t,[e,a]):Zr.resizeBilinear(t,[e,a])}}))}getConfig(){const e={size:this.size,dataFormat:this.dataFormat,interpolation:this.interpolation},t=super.getConfig();return Object.assign(e,t),e}}Fd.className="UpSampling2D",ka(Fd);class _d extends Nd{constructor(e){super(2,e),this.depthwiseKernel=null,this.depthMultiplier=null==e.depthMultiplier?1:e.depthMultiplier,this.depthwiseInitializer=_c(e.depthwiseInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.depthwiseConstraint=Ah(e.depthwiseConstraint),this.depthwiseRegularizer=hd(e.depthwiseRegularizer)}build(e){if((e=Oc(e)).length<4)throw new il(`Inputs to DepthwiseConv2D should have rank 4. Received input shape: ${JSON.stringify(e)}.`);const t="channelsFirst"===this.dataFormat?1:3;if(null==e[t]||e[t]<0)throw new il(`The channel dimension of the inputs to DepthwiseConv2D should be defined, but is not (${e[t]}).`);const n=e[t],a=[this.kernelSize[0],this.kernelSize[1],n,this.depthMultiplier];this.depthwiseKernel=this.addWeight("depthwise_kernel",a,null,this.depthwiseInitializer,this.depthwiseRegularizer,!0,this.depthwiseConstraint),this.useBias?this.bias=this.addWeight("bias",[n*this.depthMultiplier],null,this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint):this.bias=null,this.built=!0}call(e,t){return wn((()=>{let t=
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function(e,t,n=[1,1],a="valid",i,s){return wn((()=>{null==i&&(i="channelsLast"),Ll(i);let r=kd(e,i);if(4!==e.rank)throw new il(`Input for depthwiseConv2d is required to be 4-D, but is instead ${e.rank}-D`);if(4!==t.rank)throw new il(`depthwiseKernel is required to be 4-D, but is instead ${t.rank}-D`);return r=yi(r,t,n,"same"===a?"same":"valid","NHWC",s),"channelsFirst"===i&&(r=pa(r,[0,3,1,2])),r}))}(e=Mc(e),this.depthwiseKernel.read(),this.strides,this.padding,this.dataFormat,null);return this.useBias&&(t=hc(t,this.bias.read(),this.dataFormat)),null!=this.activation&&(t=this.activation.apply(t)),t}))}computeOutputShape(e){e=Oc(e);const t="channelsFirst"===this.dataFormat?e[2]:e[1],n="channelsFirst"===this.dataFormat?e[3]:e[2],a="channelsFirst"===this.dataFormat?e[1]*this.depthMultiplier:e[3]*this.depthMultiplier,i=bd(t,this.kernelSize[0],this.padding,this.strides[0]),s=bd(n,this.kernelSize[1],this.padding,this.strides[1]);return"channelsFirst"===this.dataFormat?[e[0],a,i,s]:[e[0],i,s,a]}getConfig(){const e=super.getConfig();return e.depthMultiplier=this.depthMultiplier,e.depthwiseInitializer=Fc(this.depthwiseInitializer),e.depthwiseRegularizer=cd(this.depthwiseRegularizer),e.depthwiseConstraint=Ch(this.depthwiseRegularizer),e}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function Rd(e,t,n,a){if(Array.isArray(e)){if(null!=t||null!=n)throw new il("When inputs is an array, neither initialState or constants should be provided");null!=a&&(n=e.slice(e.length-a,e.length),e=e.slice(0,e.length-a)),e.length>1&&(t=e.slice(1,e.length)),e=e[0]}function i(e){return null==e||Array.isArray(e)?e:[e]}return{inputs:e,initialState:t=i(t),constants:n=i(n)}}function Ld(e,t,n,a=!1,i,s,r=!1,o=!1){return wn((()=>{const s=t.shape.length;if(s<3)throw new il(`Input should be at least 3D, but is ${s}D.`);const l=[1,0].concat(Jl(2,s));t=pa(t,l),r&&console.warn("Backend rnn(): the unroll = true option is not applicable to the imperative deeplearn.js backend."),null!=i&&((i=ra(ra(i,"bool"),"float32")).rank===s-1&&(i=Pi(i,-1)),i=pa(i,l)),a&&(t=Zs(t,0),null!=i&&(i=Zs(i,0)));const c=[];let u,h=n;const p=t.shape[0],d=gr(t);let f,m;null!=i&&(f=gr(i));for(let t=0;t<p;++t){const n=d[t],a=wn((()=>e(n,h)));if(null==i)u=a[0],h=a[1];else{const e=wn((()=>{const e=f[t],n=es(fs(e),e);return{output:xa(Ta(a[0],e),Ta(h[0],n)),newStates:h.map(((t,i)=>xa(Ta(a[1][i],e),Ta(t,n))))}}));u=e.output,h=e.newStates}o&&c.push(u)}if(o){m=ur(c,1)}return[u,m,h]}))}_d.className="DepthwiseConv2D",ka(_d);class Md extends Zc{constructor(e){let t;if(super(e),null==e.cell)throw new il("cell property is missing for the constructor of RNN.");if(t=Array.isArray(e.cell)?new Kd({cells:e.cell}):e.cell,null==t.stateSize)throw new il("The RNN cell should have an attribute `stateSize` (tuple of integers, one integer per RNN state).");this.cell=t,this.returnSequences=null!=e.returnSequences&&e.returnSequences,this.returnState=null!=e.returnState&&e.returnState,this.goBackwards=null!=e.goBackwards&&e.goBackwards,this._stateful=null!=e.stateful&&e.stateful,this.unroll=null!=e.unroll&&e.unroll,this.supportsMasking=!0,this.inputSpec=[new Vc({ndim:3})],this.stateSpec=null,this.states_=null,this.numConstants=null,this.keptStates=[]}getStates(){if(null==this.states_){return Jl(0,Array.isArray(this.cell.stateSize)?this.cell.stateSize.length:1).map((e=>null))}return this.states_}setStates(e){this.states_=e}computeOutputShape(e){Rc(e)&&(e=e[0]);let t=this.cell.stateSize;Array.isArray(t)||(t=[t]);const n=t[0];let a;if(a=this.returnSequences?[e[0],e[1],n]:[e[0],n],this.returnState){const n=[];for(const a of t)n.push([e[0],a]);return[a].concat(n)}return a}computeMask(e,t){return wn((()=>{Array.isArray(t)&&(t=t[0]);const e=this.returnSequences?t:null;if(this.returnState){const t=this.states.map((e=>null));return[e].concat(t)}return e}))}get states(){if(null==this.states_){const e=Array.isArray(this.cell.stateSize)?this.cell.stateSize.length:1,t=[];for(let n=0;n<e;++n)t.push(null);return t}return this.states_}set states(e){this.states_=e}build(e){if(null!=this.numConstants)throw new sl("Constants support is not implemented in RNN yet.");Rc(e)&&(e=e[0]);const t=this.stateful?e[0]:null,n=e.slice(2);this.inputSpec[0]=new Vc({shape:[t,null,...n]});const a=[e[0]].concat(e.slice(2));let i;if(this.cell.build(a),i=Array.isArray(this.cell.stateSize)?this.cell.stateSize:[this.cell.stateSize],null!=this.stateSpec){if(!T(this.stateSpec.map((e=>e.shape[e.shape.length-1])),i))throw new il(`An initialState was passed that is not compatible with cell.stateSize. Received stateSpec=${this.stateSpec}; However cell.stateSize is ${this.cell.stateSize}`)}else this.stateSpec=i.map((e=>new Vc({shape:[null,e]})));this.stateful&&this.resetStates()}resetStates(e,t=!1){wn((()=>{if(!this.stateful)throw new nl("Cannot call resetStates() on an RNN Layer that is not stateful.");const n=this.inputSpec[0].shape[0];if(null==n)throw new il("If an RNN is stateful, it needs to know its batch size. Specify the batch size of your input tensors: \n- If using a Sequential model, specify the batch size by passing a `batchInputShape` option to your first layer.\n- If using the functional API, specify the batch size by passing a `batchShape` option to your Input layer.");if(null==this.states_)Array.isArray(this.cell.stateSize)?this.states_=this.cell.stateSize.map((e=>cs([n,e]))):this.states_=[cs([n,this.cell.stateSize])];else if(null==e)kn(this.states_),null!=this.keptStates&&(kn(this.keptStates),this.keptStates=[]),Array.isArray(this.cell.stateSize)?this.states_=this.cell.stateSize.map((e=>cs([n,e]))):this.states_[0]=cs([n,this.cell.stateSize]);else{if(Array.isArray(e)||(e=[e]),e.length!==this.states_.length)throw new il(`Layer ${this.name} expects ${this.states_.length} state(s), but it received ${e.length} state value(s). Input received: ${e}`);!0===t?this.keptStates.push(this.states_.slice()):kn(this.states_);for(let t=0;t<this.states_.length;++t){const a=e[t],i=Array.isArray(this.cell.stateSize)?this.cell.stateSize[t]:this.cell.stateSize,s=[n,i];if(!T(a.shape,s))throw new il(`State ${t} is incompatible with layer ${this.name}: expected shape=${s}, received shape=${a.shape}`);this.states_[t]=a}}this.states_=this.states_.map((e=>xn(e.clone())))}))}apply(e,t){let n=null==t?null:t.initialState,a=null==t?null:t.constants;null==t&&(t={});const i=Rd(e,n,a,this.numConstants);e=i.inputs,n=i.initialState,a=i.constants;let s=[],r=[];if(null!=n){t.initialState=n,s=s.concat(n),this.stateSpec=[];for(const e of n)this.stateSpec.push(new Vc({shape:e.shape}));r=r.concat(this.stateSpec)}null!=a&&(t.constants=a,s=s.concat(a),this.numConstants=a.length);if(s[0]instanceof Kc){const n=[e].concat(s),a=this.inputSpec.concat(r),i=this.inputSpec;this.inputSpec=a;const o=super.apply(n,t);return this.inputSpec=i,o}return super.apply(e,t)}call(e,t){return wn((()=>{const n=null==t?null:t.mask,a=null==t?null:t.training;let i=null==t?null:t.initialState;e=Mc(e),null==i&&(i=this.stateful?this.states_:this.getInitialState(e));const s=Array.isArray(this.cell.stateSize)?this.cell.stateSize.length:1;if(i.length!==s)throw new il(`RNN Layer has ${s} state(s) but was passed ${i.length} initial state(s).`);this.unroll&&console.warn("Ignoring unroll = true for RNN layer, due to imperative backend.");const r={training:a},o=Ld(((e,t)=>{const n=this.cell.call([e].concat(t),r);return[n[0],n.slice(1)]}),e,i,this.goBackwards,n,0,this.unroll,this.returnSequences),l=o[0],c=o[1],u=o[2];this.stateful&&this.resetStates(u,a);const h=this.returnSequences?c:l;return this.returnState?[h].concat(u):h}))}getInitialState(e){return wn((()=>{let t=cs(e.shape);return t=Ri(t,[1,2]),t=Xl(t),Array.isArray(this.cell.stateSize)?this.cell.stateSize.map((e=>e>1?sc(t,[1,e]):t)):this.cell.stateSize>1?[sc(t,[1,this.cell.stateSize])]:[t]}))}get trainableWeights(){return this.trainable?this.cell.trainableWeights:[]}get nonTrainableWeights(){return this.trainable?this.cell.nonTrainableWeights:this.cell.weights}setFastWeightInitDuringBuild(e){super.setFastWeightInitDuringBuild(e),null!=this.cell&&this.cell.setFastWeightInitDuringBuild(e)}getConfig(){const e=super.getConfig(),t={returnSequences:this.returnSequences,returnState:this.returnState,goBackwards:this.goBackwards,stateful:this.stateful,unroll:this.unroll};null!=this.numConstants&&(t.numConstants=this.numConstants);const n=this.cell.getConfig();return this.getClassName()===Md.className&&(t.cell={className:this.cell.getClassName(),config:n}),Object.assign(Object.assign(Object.assign({},n),e),t)}static fromConfig(e,t,n={}){const a=Bh(t.cell,n);return new e(Object.assign(t,{cell:a}))}}Md.className="RNN",ka(Md);class Od extends Zc{}class Pd extends Od{constructor(e){super(e),this.DEFAULT_ACTIVATION="tanh",this.DEFAULT_KERNEL_INITIALIZER="glorotNormal",this.DEFAULT_RECURRENT_INITIALIZER="orthogonal",this.DEFAULT_BIAS_INITIALIZER="zeros",this.units=e.units,Nl(this.units,"units"),this.activation=sd(null==e.activation?this.DEFAULT_ACTIVATION:e.activation),this.useBias=null==e.useBias||e.useBias,this.kernelInitializer=_c(e.kernelInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.recurrentInitializer=_c(e.recurrentInitializer||this.DEFAULT_RECURRENT_INITIALIZER),this.biasInitializer=_c(e.biasInitializer||this.DEFAULT_BIAS_INITIALIZER),this.kernelRegularizer=hd(e.kernelRegularizer),this.recurrentRegularizer=hd(e.recurrentRegularizer),this.biasRegularizer=hd(e.biasRegularizer),this.kernelConstraint=Ah(e.kernelConstraint),this.recurrentConstraint=Ah(e.recurrentConstraint),this.biasConstraint=Ah(e.biasConstraint),this.dropout=ql([1,Hl([0,null==e.dropout?0:e.dropout])]),this.recurrentDropout=ql([1,Hl([0,null==e.recurrentDropout?0:e.recurrentDropout])]),this.dropoutFunc=e.dropoutFunc,this.stateSize=this.units,this.dropoutMask=null,this.recurrentDropoutMask=null}build(e){e=Oc(e),this.kernel=this.addWeight("kernel",[e[e.length-1],this.units],null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.recurrentKernel=this.addWeight("recurrent_kernel",[this.units,this.units],null,this.recurrentInitializer,this.recurrentRegularizer,!0,this.recurrentConstraint),this.useBias?this.bias=this.addWeight("bias",[this.units],null,this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint):this.bias=null,this.built=!0}call(e,t){return wn((()=>{if(2!==e.length)throw new il(`SimpleRNNCell expects 2 input Tensors, got ${e.length}.`);let n=e[1];e=e[0];const a=null!=t.training&&t.training;let i;0<this.dropout&&this.dropout<1&&null==this.dropoutMask&&(this.dropoutMask=qd({ones:()=>fs(e),rate:this.dropout,training:a,dropoutFunc:this.dropoutFunc})),0<this.recurrentDropout&&this.recurrentDropout<1&&null==this.recurrentDropoutMask&&(this.recurrentDropoutMask=qd({ones:()=>fs(n),rate:this.recurrentDropout,training:a,dropoutFunc:this.dropoutFunc}));const s=this.dropoutMask,r=this.recurrentDropoutMask;i=oc(null!=s?Ta(e,s):e,this.kernel.read()),null!=this.bias&&(i=hc(i,this.bias.read())),null!=r&&(n=Ta(n,r));let o=xa(i,oc(n,this.recurrentKernel.read()));return null!=this.activation&&(o=this.activation.apply(o)),[o,o]}))}getConfig(){const e=super.getConfig(),t={units:this.units,activation:ad(this.activation),useBias:this.useBias,kernelInitializer:Fc(this.kernelInitializer),recurrentInitializer:Fc(this.recurrentInitializer),biasInitializer:Fc(this.biasInitializer),kernelRegularizer:cd(this.kernelRegularizer),recurrentRegularizer:cd(this.recurrentRegularizer),biasRegularizer:cd(this.biasRegularizer),activityRegularizer:cd(this.activityRegularizer),kernelConstraint:Ch(this.kernelConstraint),recurrentConstraint:Ch(this.recurrentConstraint),biasConstraint:Ch(this.biasConstraint),dropout:this.dropout,recurrentDropout:this.recurrentDropout};return Object.assign(Object.assign({},e),t)}}Pd.className="SimpleRNNCell",ka(Pd);class Bd extends Md{constructor(e){e.cell=new Pd(e),super(e)}call(e,t){return wn((()=>{null!=this.cell.dropoutMask&&(kn(this.cell.dropoutMask),this.cell.dropoutMask=null),null!=this.cell.recurrentDropoutMask&&(kn(this.cell.recurrentDropoutMask),this.cell.recurrentDropoutMask=null);const n=null==t?null:t.mask,a=null==t?null:t.training,i=null==t?null:t.initialState;return super.call(e,{mask:n,training:a,initialState:i})}))}static fromConfig(e,t){return new e(t)}}Bd.className="SimpleRNN",ka(Bd);class Ud extends Od{constructor(e){if(super(e),this.DEFAULT_ACTIVATION="tanh",this.DEFAULT_RECURRENT_ACTIVATION="hardSigmoid",this.DEFAULT_KERNEL_INITIALIZER="glorotNormal",this.DEFAULT_RECURRENT_INITIALIZER="orthogonal",this.DEFAULT_BIAS_INITIALIZER="zeros",e.resetAfter)throw new il("GRUCell does not support reset_after parameter set to true.");this.units=e.units,Nl(this.units,"units"),this.activation=sd(void 0===e.activation?this.DEFAULT_ACTIVATION:e.activation),this.recurrentActivation=sd(void 0===e.recurrentActivation?this.DEFAULT_RECURRENT_ACTIVATION:e.recurrentActivation),this.useBias=null==e.useBias||e.useBias,this.kernelInitializer=_c(e.kernelInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.recurrentInitializer=_c(e.recurrentInitializer||this.DEFAULT_RECURRENT_INITIALIZER),this.biasInitializer=_c(e.biasInitializer||this.DEFAULT_BIAS_INITIALIZER),this.kernelRegularizer=hd(e.kernelRegularizer),this.recurrentRegularizer=hd(e.recurrentRegularizer),this.biasRegularizer=hd(e.biasRegularizer),this.kernelConstraint=Ah(e.kernelConstraint),this.recurrentConstraint=Ah(e.recurrentConstraint),this.biasConstraint=Ah(e.biasConstraint),this.dropout=ql([1,Hl([0,null==e.dropout?0:e.dropout])]),this.recurrentDropout=ql([1,Hl([0,null==e.recurrentDropout?0:e.recurrentDropout])]),this.dropoutFunc=e.dropoutFunc,this.implementation=e.implementation,this.stateSize=this.units,this.dropoutMask=null,this.recurrentDropoutMask=null}build(e){const t=(e=Oc(e))[e.length-1];this.kernel=this.addWeight("kernel",[t,3*this.units],null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.recurrentKernel=this.addWeight("recurrent_kernel",[this.units,3*this.units],null,this.recurrentInitializer,this.recurrentRegularizer,!0,this.recurrentConstraint),this.useBias?this.bias=this.addWeight("bias",[3*this.units],null,this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint):this.bias=null,this.built=!0}call(e,t){return wn((()=>{if(2!==e.length)throw new il(`GRUCell expects 2 input Tensors (inputs, h, c), got ${e.length}.`);const n=null!=t.training&&t.training;let a=e[1];e=e[0],0<this.dropout&&this.dropout<1&&null==this.dropoutMask&&(this.dropoutMask=qd({ones:()=>fs(e),rate:this.dropout,training:n,count:3,dropoutFunc:this.dropoutFunc})),0<this.recurrentDropout&&this.recurrentDropout<1&&null==this.recurrentDropoutMask&&(this.recurrentDropoutMask=qd({ones:()=>fs(a),rate:this.recurrentDropout,training:n,count:3,dropoutFunc:this.dropoutFunc}));const i=this.dropoutMask,s=this.recurrentDropoutMask;let r,o,l;0<this.dropout&&this.dropout<1&&(e=Ta(e,i[0]));let c=oc(e,this.kernel.read());this.useBias&&(c=hc(c,this.bias.read())),0<this.recurrentDropout&&this.recurrentDropout<1&&(a=Ta(a,s[0]));const u=this.recurrentKernel.read(),[h,p]=lr(u,[2*this.units,this.units],u.rank-1),d=oc(a,h),[f,m,g]=lr(c,3,c.rank-1),[v,y]=lr(d,2,d.rank-1);r=this.recurrentActivation.apply(xa(f,v)),o=this.recurrentActivation.apply(xa(m,y));const b=oc(Ta(o,a),p);l=this.activation.apply(xa(g,b));const w=xa(Ta(r,a),Ta(xa(1,ua(r)),l));return[w,w]}))}getConfig(){const e=super.getConfig(),t={units:this.units,activation:ad(this.activation),recurrentActivation:ad(this.recurrentActivation),useBias:this.useBias,kernelInitializer:Fc(this.kernelInitializer),recurrentInitializer:Fc(this.recurrentInitializer),biasInitializer:Fc(this.biasInitializer),kernelRegularizer:cd(this.kernelRegularizer),recurrentRegularizer:cd(this.recurrentRegularizer),biasRegularizer:cd(this.biasRegularizer),activityRegularizer:cd(this.activityRegularizer),kernelConstraint:Ch(this.kernelConstraint),recurrentConstraint:Ch(this.recurrentConstraint),biasConstraint:Ch(this.biasConstraint),dropout:this.dropout,recurrentDropout:this.recurrentDropout,implementation:this.implementation,resetAfter:!1};return Object.assign(Object.assign({},e),t)}}Ud.className="GRUCell",ka(Ud);class Wd extends Md{constructor(e){0===e.implementation&&console.warn("`implementation=0` has been deprecated, and now defaults to `implementation=1`. Please update your layer call."),e.cell=new Ud(e),super(e)}call(e,t){return wn((()=>{null!=this.cell.dropoutMask&&(kn(this.cell.dropoutMask),this.cell.dropoutMask=null),null!=this.cell.recurrentDropoutMask&&(kn(this.cell.recurrentDropoutMask),this.cell.recurrentDropoutMask=null);const n=null==t?null:t.mask,a=null==t?null:t.training,i=null==t?null:t.initialState;return super.call(e,{mask:n,training:a,initialState:i})}))}static fromConfig(e,t){return 0===t.implmentation&&(t.implementation=1),new e(t)}}Wd.className="GRU",ka(Wd);class Gd extends Od{constructor(e){super(e),this.DEFAULT_ACTIVATION="tanh",this.DEFAULT_RECURRENT_ACTIVATION="hardSigmoid",this.DEFAULT_KERNEL_INITIALIZER="glorotNormal",this.DEFAULT_RECURRENT_INITIALIZER="orthogonal",this.DEFAULT_BIAS_INITIALIZER="zeros",this.units=e.units,Nl(this.units,"units"),this.activation=sd(void 0===e.activation?this.DEFAULT_ACTIVATION:e.activation),this.recurrentActivation=sd(void 0===e.recurrentActivation?this.DEFAULT_RECURRENT_ACTIVATION:e.recurrentActivation),this.useBias=null==e.useBias||e.useBias,this.kernelInitializer=_c(e.kernelInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.recurrentInitializer=_c(e.recurrentInitializer||this.DEFAULT_RECURRENT_INITIALIZER),this.biasInitializer=_c(e.biasInitializer||this.DEFAULT_BIAS_INITIALIZER),this.unitForgetBias=e.unitForgetBias,this.kernelRegularizer=hd(e.kernelRegularizer),this.recurrentRegularizer=hd(e.recurrentRegularizer),this.biasRegularizer=hd(e.biasRegularizer),this.kernelConstraint=Ah(e.kernelConstraint),this.recurrentConstraint=Ah(e.recurrentConstraint),this.biasConstraint=Ah(e.biasConstraint),this.dropout=ql([1,Hl([0,null==e.dropout?0:e.dropout])]),this.recurrentDropout=ql([1,Hl([0,null==e.recurrentDropout?0:e.recurrentDropout])]),this.dropoutFunc=e.dropoutFunc,this.implementation=e.implementation,this.stateSize=[this.units,this.units],this.dropoutMask=null,this.recurrentDropoutMask=null}build(e){var t;const n=(e=Oc(e))[e.length-1];let a;if(this.kernel=this.addWeight("kernel",[n,4*this.units],null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.recurrentKernel=this.addWeight("recurrent_kernel",[this.units,4*this.units],null,this.recurrentInitializer,this.recurrentRegularizer,!0,this.recurrentConstraint),this.useBias){if(this.unitForgetBias){const e=this.biasInitializer,n=this.units;a=new((t=class extends gc{apply(t,a){const i=e.apply([n]),s=(new yc).apply([n]),r=e.apply([2*n]);return ic(ic(i,s),r)}}).className="CustomInit",t)}else a=this.biasInitializer;this.bias=this.addWeight("bias",[4*this.units],null,a,this.biasRegularizer,!0,this.biasConstraint)}else this.bias=null;this.built=!0}call(e,t){return wn((()=>{const n=null!=t.training&&t.training;if(3!==e.length)throw new il(`LSTMCell expects 3 input Tensors (inputs, h, c), got ${e.length}.`);let a=e[1];const i=e[2];e=e[0],0<this.dropout&&this.dropout<1&&null==this.dropoutMask&&(this.dropoutMask=qd({ones:()=>fs(e),rate:this.dropout,training:n,count:4,dropoutFunc:this.dropoutFunc})),0<this.recurrentDropout&&this.recurrentDropout<1&&null==this.recurrentDropoutMask&&(this.recurrentDropoutMask=qd({ones:()=>fs(a),rate:this.recurrentDropout,training:n,count:4,dropoutFunc:this.dropoutFunc}));const s=this.dropoutMask,r=this.recurrentDropoutMask;let o,l,c,u;0<this.dropout&&this.dropout<1&&(e=Ta(e,s[0]));let h=oc(e,this.kernel.read());0<this.recurrentDropout&&this.recurrentDropout<1&&(a=Ta(a,r[0])),h=xa(h,oc(a,this.recurrentKernel.read())),this.useBias&&(h=hc(h,this.bias.read()));const[p,d,f,m]=lr(h,4,h.rank-1);o=this.recurrentActivation.apply(p),l=this.recurrentActivation.apply(d),c=xa(Ta(l,i),Ta(o,this.activation.apply(f))),u=this.recurrentActivation.apply(m);const g=Ta(u,this.activation.apply(c));return[g,g,c]}))}getConfig(){const e=super.getConfig(),t={units:this.units,activation:ad(this.activation),recurrentActivation:ad(this.recurrentActivation),useBias:this.useBias,kernelInitializer:Fc(this.kernelInitializer),recurrentInitializer:Fc(this.recurrentInitializer),biasInitializer:Fc(this.biasInitializer),unitForgetBias:this.unitForgetBias,kernelRegularizer:cd(this.kernelRegularizer),recurrentRegularizer:cd(this.recurrentRegularizer),biasRegularizer:cd(this.biasRegularizer),activityRegularizer:cd(this.activityRegularizer),kernelConstraint:Ch(this.kernelConstraint),recurrentConstraint:Ch(this.recurrentConstraint),biasConstraint:Ch(this.biasConstraint),dropout:this.dropout,recurrentDropout:this.recurrentDropout,implementation:this.implementation};return Object.assign(Object.assign({},e),t)}}Gd.className="LSTMCell",ka(Gd);class Vd extends Md{constructor(e){0===e.implementation&&console.warn("`implementation=0` has been deprecated, and now defaults to `implementation=1`. Please update your layer call."),e.cell=new Gd(e),super(e)}call(e,t){return wn((()=>{null!=this.cell.dropoutMask&&(kn(this.cell.dropoutMask),this.cell.dropoutMask=null),null!=this.cell.recurrentDropoutMask&&(kn(this.cell.recurrentDropoutMask),this.cell.recurrentDropoutMask=null);const n=null==t?null:t.mask,a=null==t?null:t.training,i=null==t?null:t.initialState;return super.call(e,{mask:n,training:a,initialState:i})}))}static fromConfig(e,t){return 0===t.implmentation&&(t.implementation=1),new e(t)}}Vd.className="LSTM",ka(Vd);class Kd extends Od{constructor(e){super(e),this.cells=e.cells}get stateSize(){const e=[];for(const t of this.cells.slice().reverse())Array.isArray(t.stateSize)?e.push(...t.stateSize):e.push(t.stateSize);return e}call(e,t){return wn((()=>{let n=e.slice(1);const a=[];for(const e of this.cells.slice().reverse())Array.isArray(e.stateSize)?a.push(n.splice(0,e.stateSize.length)):a.push(n.splice(0,1));a.reverse();const i=[];let s;for(let r=0;r<this.cells.length;++r){const o=this.cells[r];n=a[r],s=0===r?[e[0]].concat(n):[s[0]].concat(n),s=o.call(s,t),i.push(s.slice(1))}n=[];for(const e of i.slice().reverse())n.push(...e);return[s[0]].concat(n)}))}build(e){let t;Rc(e)&&(e=e[0]),this.cells.forEach(((n,a)=>{Bl(`RNNCell_${a}`,(()=>{n.build(e),t=Array.isArray(n.stateSize)?n.stateSize[0]:n.stateSize,e=[e[0],t]}))})),this.built=!0}getConfig(){const e=super.getConfig(),t={cells:this.cells.map((e=>({className:e.getClassName(),config:e.getConfig()})))};return Object.assign(Object.assign({},e),t)}static fromConfig(e,t,n={}){const a=[];for(const e of t.cells)a.push(Bh(e,n));return new e({cells:a})}get trainableWeights(){if(!this.trainable)return[];const e=[];for(const t of this.cells)e.push(...t.trainableWeights);return e}get nonTrainableWeights(){const e=[];for(const t of this.cells)e.push(...t.nonTrainableWeights);if(!this.trainable){const t=[];for(const e of this.cells)t.push(...e.trainableWeights);return t.concat(e)}return e}getWeights(){const e=[];for(const t of this.cells)e.push(...t.weights);return Wc(e)}setWeights(e){const t=[];for(const n of this.cells){const a=n.weights.length,i=e.splice(a);for(let e=0;e<n.weights.length;++e)t.push([n.weights[e],i[e]])}Gc(t)}}function qd(e){const{ones:t,rate:n,training:a=!1,count:i=1,dropoutFunc:s}=e,r=()=>null!=s?s(t(),n):pc(t(),n),o=()=>dc(r,t,a);if(!i||i<=1)return xn(o().clone());return Array(i).fill(void 0).map(o).map((e=>xn(e.clone())))}
/**
     * @license
     * Copyright 2020 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */Kd.className="StackedRNNCells",ka(Kd);var Hd=function(e,t){var n={};for(var a in e)Object.prototype.hasOwnProperty.call(e,a)&&t.indexOf(a)<0&&(n[a]=e[a]);if(null!=e&&"function"==typeof Object.getOwnPropertySymbols){var i=0;for(a=Object.getOwnPropertySymbols(e);i<a.length;i++)t.indexOf(a[i])<0&&Object.prototype.propertyIsEnumerable.call(e,a[i])&&(n[a[i]]=e[a[i]])}return n};class Jd extends Md{constructor(e){if(e.unroll)throw new sl("Unrolling is not possible with convolutional RNNs.");if(Array.isArray(e.cell))throw new sl("It is not possible at the moment to stack convolutional cells.");super(e),this.inputSpec=[new Vc({ndim:5})]}call(e,t){return wn((()=>{if(null!=this.cell.dropoutMask&&(kn(this.cell.dropoutMask),this.cell.dropoutMask=null),null!=this.cell.recurrentDropoutMask&&(kn(this.cell.recurrentDropoutMask),this.cell.recurrentDropoutMask=null),t&&t.constants)throw new il("ConvRNN2D cell does not support constants");const n=null==t?null:t.mask,a=null==t?null:t.training,i=null==t?null:t.initialState;return super.call(e,{mask:n,training:a,initialState:i})}))}computeOutputShape(e){let t=this.computeSingleOutputShape(e);return this.returnSequences||(t=[t[0],...t.slice(2)]),this.returnState&&(t=[t,...Array(2).fill([e[0],...t.slice(-3)])]),t}getInitialState(e){return wn((()=>{const{stateSize:t}=this.cell,n=e.shape,a=this.computeSingleOutputShape(n),i=cs([a[0],...a.slice(2)]);return Array.isArray(t)?Array(t.length).fill(i):[i]}))}resetStates(e,t=!1){wn((()=>{if(!this.stateful)throw new nl("Cannot call resetStates() on an RNN Layer that is not stateful.");const n=this.inputSpec[0].shape,a=this.computeSingleOutputShape(n),i=[a[0],...a.slice(2)];if(null==n[0])throw new il("If an RNN is stateful, it needs to know its batch size. Specify the batch size of your input tensors: \n- If using a Sequential model, specify the batch size by passing a `batchInputShape` option to your first layer.\n- If using the functional API, specify the batch size by passing a `batchShape` option to your Input layer.");if(null==this.getStates())Array.isArray(this.cell.stateSize)?this.states_=this.cell.stateSize.map((()=>cs(i))):this.states_=[cs(i)];else if(null==e)kn(this.states_),null!=this.keptStates&&(kn(this.keptStates),this.keptStates=[]),Array.isArray(this.cell.stateSize)?this.states_=this.cell.stateSize.map((()=>cs(i))):this.states_[0]=cs(i);else{if(Array.isArray(e)||(e=[e]),e.length!==this.states_.length)throw new il(`Layer ${this.name} expects ${this.states_.length} state(s), but it received ${e.length} state value(s). Input received: ${e}`);t?this.keptStates.push(this.states_.slice()):kn(this.states_);for(let t=0;t<this.states_.length;++t){const n=e[t],a=i;if(!T(n.shape,a))throw new il(`State ${t} is incompatible with layer ${this.name}: expected shape=${a}, received shape=${n.shape}`);this.states_[t]=n}}this.states_=this.states_.map((e=>xn(e.clone())))}))}computeSingleOutputShape(e){const{dataFormat:t,filters:n,kernelSize:a,padding:i,strides:s,dilationRate:r}=this.cell,o="channelsFirst"===t,l=e[o?3:2],c=e[o?4:3],u=bd(l,a[0],i,s[0],r[0]),h=bd(c,a[1],i,s[1],r[1]);return[...e.slice(0,2),...o?[n,u,h]:[u,h,n]]}}Jd.className="ConvRNN2D";class Zd extends Gd{constructor(e){const{filters:t,kernelSize:n,strides:a,padding:i,dataFormat:s,dilationRate:r}=e;super(Object.assign(Object.assign({},e),{units:t})),this.filters=t,Nl(this.filters,"filters"),this.kernelSize=yd(n,2,"kernelSize"),this.kernelSize.forEach((e=>Nl(e,"kernelSize"))),this.strides=yd(a||1,2,"strides"),this.strides.forEach((e=>Nl(e,"strides"))),this.padding=i||"valid",Ml(this.padding),this.dataFormat=s||"channelsLast",Ll(this.dataFormat),this.dilationRate=yd(r||1,2,"dilationRate"),this.dilationRate.forEach((e=>Nl(e,"dilationRate")))}build(e){var t;e=Oc(e);const n="channelsFirst"===this.dataFormat?1:e.length-1;if(null==e[n])throw new il(`The channel dimension of the input should be defined. Found ${e[n]}`);const a=e[n],i=this.kernelSize.concat([a,4*this.filters]);this.kernel=this.addWeight("kernel",i,null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint);const s=this.kernelSize.concat([this.filters,4*this.filters]);if(this.recurrentKernel=this.addWeight("recurrent_kernel",s,null,this.recurrentInitializer,this.recurrentRegularizer,!0,this.recurrentConstraint),this.useBias){let e;if(this.unitForgetBias){const n=this.biasInitializer,a=this.filters;e=new((t=class extends gc{apply(e,t){return ac([n.apply([a]),us([a]),n.apply([2*a])])}}).className="CustomInit",t)}else e=this.biasInitializer;this.bias=this.addWeight("bias",[4*this.filters],null,e,this.biasRegularizer,!0,this.biasConstraint)}this.built=!0}call(e,t){return wn((()=>{if(3!==e.length)throw new il(`ConvLSTM2DCell expects 3 input Tensors (inputs, h, c), got ${e.length}.`);const n=t.training||!1,a=e[0],i=e[1],s=e[2];0<this.dropout&&this.dropout<1&&null==this.dropoutMask&&(this.dropoutMask=qd({ones:()=>fs(a),rate:this.dropout,training:n,count:4,dropoutFunc:this.dropoutFunc}));const r=this.dropoutMask,o=(e,t,n)=>t&&t[n]?Ta(t[n],e):e;let l=o(a,r,0),c=o(a,r,1),u=o(a,r,2),h=o(a,r,3);0<this.recurrentDropout&&this.recurrentDropout<1&&null==this.recurrentDropoutMask&&(this.recurrentDropoutMask=qd({ones:()=>fs(i),rate:this.recurrentDropout,training:n,count:4,dropoutFunc:this.dropoutFunc}));const p=this.recurrentDropoutMask;let d=o(i,p,0),f=o(i,p,1),m=o(i,p,2),g=o(i,p,3);const[v,y,b,w]=lr(this.kernel.read(),4,3),[k,x,S,N]=this.useBias?lr(this.bias.read(),4):[null,null,null,null];l=this.inputConv(l,v,k,this.padding),c=this.inputConv(c,y,x,this.padding),u=this.inputConv(u,b,S,this.padding),h=this.inputConv(h,w,N,this.padding);const[T,I,C,$]=lr(this.recurrentKernel.read(),4,3);d=this.recurrentConv(d,T),f=this.recurrentConv(f,I),m=this.recurrentConv(m,C),g=this.recurrentConv(g,$);const A=this.recurrentActivation.apply(xa(l,d)),E=this.recurrentActivation.apply(xa(c,f)),j=xa(Ta(E,s),Ta(A,this.activation.apply(xa(u,m)))),z=Ta(this.recurrentActivation.apply(xa(h,g)),this.activation.apply(j));return[z,z,j]}))}getConfig(){const e=super.getConfig(),t=Hd(e,["units"]),n={filters:this.filters,kernelSize:this.kernelSize,padding:this.padding,dataFormat:this.dataFormat,dilationRate:this.dilationRate,strides:this.strides};return Object.assign(Object.assign({},t),n)}inputConv(e,t,n,a){const i=ri(e,t,this.strides,a||"valid","channelsFirst"===this.dataFormat?"NCHW":"NHWC",this.dilationRate);return n?hc(i,n,this.dataFormat):i}recurrentConv(e,t){return ri(e,t,1,"same","channelsFirst"===this.dataFormat?"NCHW":"NHWC")}}Zd.className="ConvLSTM2DCell",ka(Zd);class Yd extends Jd{constructor(e){const t=new Zd(e);super(Object.assign(Object.assign({},e),{cell:t}))}static fromConfig(e,t){return new e(t)}}Yd.className="ConvLSTM2D",ka(Yd);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class Qd extends Zc{constructor(e){super(e),this.rate=Math.max(Math.min(e.rate,1),0),this.noiseShape=e.noiseShape,this.seed=e.seed,this.supportsMasking=!0}getNoiseShape(e){if(null==this.noiseShape)return this.noiseShape;const t=e.shape,n=[];for(let e=0;e<this.noiseShape.length;++e)n.push(null==this.noiseShape[e]?t[e]:this.noiseShape[e]);return n}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e);if(0<this.rate&&this.rate<1){const e=null!=t.training&&t.training,a=this.getNoiseShape(n);return dc((()=>pc(n,this.rate,a,this.seed)),(()=>n),e)}return e}))}getConfig(){const e={rate:this.rate,noiseShape:this.noiseShape,seed:this.seed},t=super.getConfig();return Object.assign(e,t),e}dispose(){return super.dispose()}}Qd.className="Dropout",ka(Qd);class Xd extends Qd{constructor(e){super(e),this.inputSpec=[{ndim:3}]}getNoiseShape(e){const t=e.shape;return[t[0],1,t[2]]}}Xd.className="SpatialDropout1D",ka(Xd);class ef extends Zc{constructor(e){if(super(e),this.activation=null,this.useBias=!0,this.kernel=null,this.bias=null,this.DEFAULT_KERNEL_INITIALIZER="glorotNormal",this.DEFAULT_BIAS_INITIALIZER="zeros",null==e.batchInputShape&&null==e.inputShape&&null!=e.inputDim){let t=null;null!=e.batchSize&&(t=e.batchSize),this.batchInputShape=[t,e.inputDim]}this.units=e.units,Nl(this.units,"units"),this.activation=sd(e.activation),null!=e.useBias&&(this.useBias=e.useBias),this.kernelInitializer=_c(e.kernelInitializer||this.DEFAULT_KERNEL_INITIALIZER),this.biasInitializer=_c(e.biasInitializer||this.DEFAULT_BIAS_INITIALIZER),this.kernelConstraint=Ah(e.kernelConstraint),this.biasConstraint=Ah(e.biasConstraint),this.kernelRegularizer=hd(e.kernelRegularizer),this.biasRegularizer=hd(e.biasRegularizer),this.activityRegularizer=hd(e.activityRegularizer),this.supportsMasking=!0,this.inputSpec=[{minNDim:2}]}build(e){const t=(e=Oc(e))[e.length-1];null==this.kernel&&(this.kernel=this.addWeight("kernel",[t,this.units],null,this.kernelInitializer,this.kernelRegularizer,!0,this.kernelConstraint),this.useBias&&(this.bias=this.addWeight("bias",[this.units],null,this.biasInitializer,this.biasRegularizer,!0,this.biasConstraint))),this.inputSpec=[{minNDim:2,axes:{[-1]:t}}],this.built=!0}computeOutputShape(e){const t=(e=Oc(e)).slice();return t[t.length-1]=this.units,t}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e),a=Il(this.activation.getClassName());let i;return null!=a?i=oc(n,this.kernel.read(),a,this.bias?this.bias.read():null):(i=oc(n,this.kernel.read()),null!=this.bias&&(i=hc(i,this.bias.read())),null!=this.activation&&(i=this.activation.apply(i))),i}))}getConfig(){const e={units:this.units,activation:ad(this.activation),useBias:this.useBias,kernelInitializer:Fc(this.kernelInitializer),biasInitializer:Fc(this.biasInitializer),kernelRegularizer:cd(this.kernelRegularizer),biasRegularizer:cd(this.biasRegularizer),activityRegularizer:cd(this.activityRegularizer),kernelConstraint:Ch(this.kernelConstraint),biasConstraint:Ch(this.biasConstraint)},t=super.getConfig();return Object.assign(e,t),e}}ef.className="Dense",ka(ef);class tf extends Zc{constructor(e){super(e=e||{}),this.inputSpec=[{minNDim:3}],this.dataFormat=e.dataFormat}computeOutputShape(e){e=Oc(e);for(const t of e.slice(1))if(null==t)throw new il(`The shape of the input to "Flatten" is not fully defined (got ${e.slice(1)}). Make sure to pass a complete "input_shape" or "batch_input_shape" argument to the first layer in your model.`);return[e[0],Kl(e,1)]}call(e,t){return wn((()=>{this.invokeCallHook(e,t);let n=Mc(e);if("channelsFirst"===this.dataFormat&&n.rank>1){const e=[0];for(let t=2;t<n.rank;++t)e.push(t);e.push(1),n=pa(n,e)}return function(e){if(e.rank<=1)throw new il(`batchFlatten requires a minimum rank of 2. Got rank: ${e.rank}.`);const t=[e.shape[0],Kl(e.shape,1)];return Ma(e,t)}(n)}))}getConfig(){const e={};null!=this.dataFormat&&(e.dataFormat=this.dataFormat);const t=super.getConfig();return Object.assign(e,t),e}}tf.className="Flatten",ka(tf);class nf extends Zc{constructor(e){super(e),this.supportsMasking=!0,this.activation=sd(e.activation)}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e);return this.activation.apply(n)}))}getConfig(){const e={activation:ad(this.activation)},t=super.getConfig();return Object.assign(e,t),e}}nf.className="Activation",ka(nf);class af extends Zc{constructor(e){super(e),this.n=e.n,this.inputSpec=[{ndim:2}]}computeOutputShape(e){return[e[0],this.n,e[1]]}call(e,t){return wn((()=>{return e=Mc(e),t=e,n=this.n,wn((()=>{if(2!==t.shape.length)throw new il(`repeat() expects a rank-2 tensor, but received a rank-${t.shape.length} tensor.`);return sc(Xl(t,1),[1,n,1])}));var t,n}))}getConfig(){const e={n:this.n},t=super.getConfig();return Object.assign(e,t),e}}af.className="RepeatVector",ka(af);class sf extends Zc{constructor(e){super(e),this.targetShape=e.targetShape;for(let e=0;e<this.targetShape.length;++e)this.isUnknown(this.targetShape[e])&&(this.targetShape[e]=null)}isUnknown(e){return e<0||null==e}fixUnknownDimension(e,t){const n="Total size of new array must be unchanged.",a=t.slice();let i=1,s=null;for(let e=0;e<a.length;++e){const t=a[e];if(this.isUnknown(t)){if(null!==s)throw new il("Can only specifiy one unknown dimension.");s=e}else i*=t}const r=Kl(e);if(null!==s){if(0===i||r%i!=0)throw new il(n);a[s]=r/i}else if(r!==i)throw new il(n);return a}computeOutputShape(e){let t=!1;for(let n=0;n<e.length;++n)if(this.isUnknown(e[n])){t=!0;break}return t?e.slice(0,1).concat(this.targetShape):e.slice(0,1).concat(this.fixUnknownDimension(e.slice(1),this.targetShape))}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e),a=n.shape,i=a.slice(0,1).concat(this.fixUnknownDimension(a.slice(1),this.targetShape));return Ma(n,i)}))}getConfig(){const e={targetShape:this.targetShape},t=super.getConfig();return Object.assign(e,t),e}}sf.className="Reshape",ka(sf);class rf extends Zc{constructor(e){if(super(e),null==e.dims)throw new Error("Required configuration field `dims` is missing during Permute constructor call.");if(!Array.isArray(e.dims))throw new Error(`Permute constructor requires \`dims\` to be an Array, but received ${e.dims} instead.`);const t=Jl(1,e.dims.length+1);if(!T(e.dims.slice().sort(),t))throw new Error("Invalid permutation `dims`: "+JSON.stringify(e.dims)+" `dims` must contain consecutive integers starting from 1.");this.dims=e.dims,this.dimsIncludingBatch=[0].concat(this.dims),this.inputSpec=[new Vc({ndim:this.dims.length+1})]}computeOutputShape(e){const t=(e=Oc(e)).slice();return this.dims.forEach(((n,a)=>{t[a+1]=e[n]})),t}call(e,t){return pa(Mc(e),this.dimsIncludingBatch)}getConfig(){const e={dims:this.dims},t=super.getConfig();return Object.assign(e,t),e}}rf.className="Permute",ka(rf);class of extends Zc{constructor(e){super(null==e?{}:e),this.supportsMasking=!0,this.maskValue=null!=e?null==e.maskValue?0:e.maskValue:0}computeOutputShape(e){return e}getConfig(){const e=super.getConfig(),t={maskValue:this.maskValue};return Object.assign(t,e),t}computeMask(e,t){const n=Mc(e);return $a(ds(n,this.maskValue),-1)}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e),a=$a(ds(n,this.maskValue),-1,!0);return Ta(n,ra(a,n.dtype))}))}}of.className="Masking",ka(of);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class lf extends Zc{constructor(e){if(super(e),this.embeddings=null,this.DEFAULT_EMBEDDINGS_INITIALIZER="randomUniform",null==e.batchInputShape&&null==e.inputShape){let t=null;null!=e.batchSize&&(t=e.batchSize),null==e.inputLength?this.batchInputShape=[t,null]:this.batchInputShape=[t].concat(pl(e.inputLength))}this.inputDim=e.inputDim,Nl(this.inputDim,"inputDim"),this.outputDim=e.outputDim,Nl(this.outputDim,"outputDim"),this.embeddingsInitializer=_c(e.embeddingsInitializer||this.DEFAULT_EMBEDDINGS_INITIALIZER),this.embeddingsRegularizer=hd(e.embeddingsRegularizer),this.activityRegularizer=hd(e.activityRegularizer),this.embeddingsConstraint=Ah(e.embeddingsConstraint),this.maskZero=e.maskZero,this.supportsMasking=e.maskZero,this.inputLength=e.inputLength}build(e){this.embeddings=this.addWeight("embeddings",[this.inputDim,this.outputDim],this.dtype,this.embeddingsInitializer,this.embeddingsRegularizer,!0,this.embeddingsConstraint),this.built=!0}warnOnIncompatibleInputShape(e){}computeMask(e,t){return wn((()=>this.maskZero?(e=Mc(e),ds(e,ki(e))):null))}computeOutputShape(e){if(e=Oc(e),null==this.inputLength)return[...e,this.outputDim];const t=pl(this.inputLength);if(t.length!==e.length-1)throw new il(`"inputLength" is ${this.inputLength}, but received input shape has shape ${e}`);{let n=0;for(let a=0;a<t.length;++a){const i=t[a],s=e[a+1];if(null!=i&&null!=s&&i!==s)throw new il(`"inputLength" is ${this.inputLength}, but received input shape has shape ${e}`);null==i&&(t[n]=s),n++}}return[e[0],...t,this.outputDim]}call(e,t){return wn((()=>{this.invokeCallHook(e,t);let n=Mc(e);"int32"!==n.dtype&&(n=Ql(n,"int32"));const a=lc(this.embeddings.read(),Ma(n,[n.size]));return Ma(a,Oc(this.computeOutputShape(n.shape)))}))}getConfig(){const e={inputDim:this.inputDim,outputDim:this.outputDim,embeddingsInitializer:Fc(this.embeddingsInitializer),embeddingsRegularizer:cd(this.embeddingsRegularizer),activityRegularizer:cd(this.activityRegularizer),embeddingsConstraint:Ch(this.embeddingsConstraint),maskZero:this.maskZero,inputLength:this.inputLength},t=super.getConfig();return Object.assign(e,t),e}}lf.className="Embedding",ka(lf);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class cf extends Zc{constructor(e){super(e||{}),this.supportsMasking=!0}mergeFunction(e){throw new sl}computeElementwiseOpOutputShape(e,t){if(null==e||null==t)return null;if(e.length<t.length)return this.computeElementwiseOpOutputShape(t,e);if(0===t.length)return e;const n=e.slice(0,e.length-t.length);for(let a=0;a<t.length;++a){const i=e[e.length-t.length+a],s=t[a];if(null==i||null==s||i<0||s<0)n.push(null);else if(1===i)n.push(s);else if(1===s)n.push(i);else{if(i!==s)throw new il("Operands could not be broadcast together with shapes "+JSON.stringify(e)+" "+JSON.stringify(t));n.push(i)}}return n}build(e){if(Array.isArray(e)&&!Array.isArray(e[0])&&(e=[Oc(e)]),e.length<2)throw new il(`A merge layer should be called on an Array of at least 2 inputs. Got ${e.length} input(s).`);let t=[];for(const n of e)null!=n&&null!==n[0]&&t.push(n[0]);if(t=wl(t),t.length>1)throw new il(`Can not merge tensors with different batch sizes. Got tensors with shapes: ${JSON.stringify(e)}.`);let n=null==e[0]?null:e[0].slice(1);for(let t=1;t<e.length;++t){const a=null==e[t]?null:e[t].slice(1);n=this.computeElementwiseOpOutputShape(n,a)}const a=e.map((e=>e.length));-1===e.indexOf(null)&&1===wl(a).length?this.reshapeRequired=!1:this.reshapeRequired=!0}call(e,t){return wn((()=>{if(this.reshapeRequired){const t=[],n=e.map((e=>e.rank));if(-1===n.indexOf(null)){const a=Hl(n);for(let n of e){const e=n.rank;for(let t=0;t<a-e;++t)n=Xl(n,1);t.push(n)}return this.mergeFunction(t)}{let n=!1;for(const a of e){const e=a.rank;if(null==e){const e=a.shape,i=e[0],s=e.slice(1).concat([i]);let r=Ma(a,[i].concat(Kl(e.slice(1))));r=pa(r,[1,0]),r=Ma(r,s),t.push(r),n=!0}else if(e>1){const i=Jl(1,e).concat([0]);t.push(pa(a,i)),n=!0}else t.push(a)}let a=this.mergeFunction(t);const i=a.rank;if(n)if(null==i){const e=a.shape,t=e[e.length-1],n=[t].concat(e.slice(0,e.length-1));a=Ma(pa(Ma(a,[-1,t]),[1,0]),n)}else if(i>1){const e=[i-1].concat(Jl(0,i-1));a=pa(a,e)}return a}}return this.mergeFunction(e)}))}computeOutputShape(e){let t;t=null==e[0]?null:e[0].slice(1);for(let n=1;n<e.length;++n){const a=null==e[n]?null:e[n].slice(1);t=this.computeElementwiseOpOutputShape(t,a)}let n=[];for(const t of e)null!=t&&null!==t[0]&&n.push(t[0]);return n=wl(n),t=1===n.length?n.concat(t):[null].concat(t),t}computeMask(e,t){return wn((()=>{if(null==t)return null;if(!Array.isArray(t))throw new il("`mask` should be an Array");if(!Array.isArray(e))throw new il("`inputs` should be an Array");if(t.length!==e.length)throw new il(`The Array 'inputs' and 'mask' are expected to have the same length, but have different lengths (${e.length} vs ${t.length})`);if(t.every((e=>null==e)))return null;let n=(t=t.map((e=>null==e?e:Pi(e,0))))[0];for(let e=1;e<t.length-1;++e)n=as(n,t[e]);return n}))}}class uf extends cf{constructor(e){super(e)}mergeFunction(e){return wn((()=>{let t=e[0].clone();for(let n=1;n<e.length;++n)t=xa(t,e[n]);return t}))}}uf.className="Add",ka(uf);class hf extends cf{constructor(e){super(e)}mergeFunction(e){return wn((()=>{let t=e[0].clone();for(let n=1;n<e.length;++n)t=Ta(t,e[n]);return t}))}}hf.className="Multiply",ka(hf);class pf extends cf{constructor(e){super(e)}mergeFunction(e){return wn((()=>{let t=e[0].clone();for(let n=1;n<e.length;++n)t=xa(t,e[n]);return Ta(1/e.length,t)}))}}pf.className="Average",ka(pf);class df extends cf{constructor(e){super(e)}mergeFunction(e){return wn((()=>{let t=e[0];for(let n=1;n<e.length;++n)t=os(t,e[n]);return t}))}}df.className="Maximum",ka(df);class ff extends cf{constructor(e){super(e)}mergeFunction(e){return wn((()=>{let t=e[0];for(let n=1;n<e.length;++n)t=hs(t,e[n]);return t}))}}ff.className="Minimum",ka(ff);class mf extends cf{constructor(e){super(e),this.DEFAULT_AXIS=-1,null==e&&(e={}),this.axis=null==e.axis?this.DEFAULT_AXIS:e.axis,this.supportsMasking=!0,this.reshapeRequired=!1}build(e){if(!Array.isArray(e)||!Array.isArray(e[0])||1===e.length)throw new il("A `Concatenate` layer should be called on a list of at least 2 inputs");let t=!0;for(const n of e)if(null!=n){t=!1;break}if(t)return;const n=[];for(let t=0;t<e.length;++t){const a=e[t].slice();a.splice(this.axis,1);let i=!1;for(const e of n)if(T(e,a)){i=!0;break}i||n.push(a)}if(n.length>1)throw new il("A `Concatenate` layer requires inputs with matching shapes except for the concat axis. Got input shapes: "+JSON.stringify(e))}mergeFunction(e){return wn((()=>ac(e,this.axis)))}computeOutputShape(e){if(!Array.isArray(e)||!Array.isArray(e[0]))throw new il("A `Concatenate` layer should be called on a list of inputs.");const t=e,n=t[0].slice(),a=this.axis<0?n.length+this.axis:this.axis;for(const e of t.slice(1)){if(null==n[a]||null==e[a]){n[a]=null;break}n[a]+=e[a]}return n}computeMask(e,t){if(null==t)return null;if(!Array.isArray(t))throw new il("`mask` should be an array for Concatenate");if(!Array.isArray(e))throw new il("`inputs` should be an array for Concatenate");if(t.length!==e.length)throw new il(`Mismatch in the length of mask (${t.length}) and the legnth of inputs (${e.length})`);return wn((()=>{let n=!0;if(t.forEach((e=>{null==e||(n=!1)})),n)return null;const a=[];for(let n=0;n<e.length;++n)null==t[n]?a.push(ra(fs(e[n]),"bool")):t[n].rank<e[n].rank?a.push(Pi(t[n],-1)):a.push(t[n]);const i=Ua(a,this.axis);return Ca(i,-1,!1)}))}getConfig(){const e={axis:this.axis},t=super.getConfig();return Object.assign(e,t),e}}function gf(e,t){for(;e<0;)e+=t;return e}mf.className="Concatenate",ka(mf);class vf extends cf{constructor(e){super(e),this.axes=e.axes,this.normalize=null!=e.normalize&&e.normalize,this.supportsMasking=!0,this.reshapeRequired=!1}build(e){x(Array.isArray(e)&&2===e.length&&Array.isArray(e[0])&&Array.isArray(e[1]),(()=>"A `Dot` layer should be called on a list of exactly 2 inputs."));const t=e[0],n=e[1];if(t.length>3||n.length>3)throw new sl("Dot layer does not support tensors of 4D or higher rank yet.");const a=this.interpretAxes(t,n);if(t[a[0]]!==n[a[1]])throw new il(`Dimension incompatibility: ${t[a[0]]} !== ${n[a[1]]}`)}mergeFunction(e){if(2!==e.length)throw new il(`A \`Dot\` layer must be called on exactly 2 inputs, but received ${e.length} input(s).`);let t,n=e[0],a=e[1];return t=Array.isArray(this.axes)?this.axes.map(((t,n)=>gf(t,e[n].shape.length))):[gf(this.axes,n.shape.length),gf(this.axes,a.shape.length)],this.normalize&&(n=Uh(n,t[0]),a=Uh(a,t[1])),function(e,t,n){if(e.shape.length>3||t.shape.length>3)throw new sl("batchDot is not implemented for tensors of 4D or higher rank yet");if(x(e.shape.length>=2,(()=>`batchDot requires the rank of x to be >= 2, but got ${e.shape.length}`)),x(e.shape.length>=2,(()=>`batchDot requires the rank of y to be >= 2, but got ${t.shape.length}`)),"number"==typeof n&&(n=[n,n]),"complex64"===e.dtype||"complex64"===t.dtype)throw new sl("batchDot is not implemented for complex64-type Tensors yet.");const a=e.shape.length,i=t.shape.length;null==n&&(n=[a-1,i-2]);const s=n;return wn((()=>{let n,r;if(a>i){n=a-i;const e=[];for(let t=0;t<n;++t)e.push(1);t=Ma(t,t.shape.concat(e))}else if(i>a){n=i-a;const t=[];for(let e=0;e<n;++e)t.push(1);e=Ma(e,e.shape.concat(t))}else n=0;if(2===e.shape.length&&2===t.shape.length)r=s[0]===s[1]?Ri(Ta(e,t),s[0]):Ri(Ta(pa(e,[1,0]),t),s[1]);else{const n=s[0]!==e.shape.length-1,a=s[1]===t.shape.length-1;r=oa(e,t,n,a)}if(n>0){let e;e=a>i?a+i-3:a-1;const t=[];for(let a=e;a<e+n;++a)t.push(a);r=cr(r,t)}return 1===r.shape.length&&(r=Pi(r,1)),r}))}(n,a,t)}interpretAxes(e,t){let n;return n=Array.isArray(this.axes)?this.axes:[gf(this.axes,e.length),gf(this.axes,t.length)],n}computeOutputShape(e){x(Array.isArray(e)&&2===e.length&&Array.isArray(e[0])&&Array.isArray(e[1]),(()=>"A `Dot` layer should be called on a list of exactly 2 inputs."));const t=e[0].slice(),n=e[1].slice();if(t.length>3||n.length>3)throw new sl("Dot layer does not support tensors of 4D or higher rank yet.");const a=this.interpretAxes(t,n);t.splice(a[0],1),n.splice(a[1],1),n.splice(0,1);const i=t.concat(n);return 1===i.length&&i.push(1),i}computeMask(e,t){return null}getConfig(){const e={axes:this.axes,normalize:this.normalize},t=super.getConfig();return Object.assign(e,t),e}}vf.className="Dot",ka(vf);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class yf extends Zc{constructor(e){super(e),this.supportsMasking=!0,this.stddev=e.stddev}computeOutputShape(e){return e}getConfig(){const e=super.getConfig(),t={stddev:this.stddev};return Object.assign(t,e),t}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e);return dc((()=>xa(rc(n.shape,0,this.stddev),n)),(()=>n),t.training||!1)}))}}yf.className="GaussianNoise",ka(yf);class bf extends Zc{constructor(e){super(e),this.supportsMasking=!0,this.rate=e.rate}computeOutputShape(e){return e}getConfig(){const e=super.getConfig(),t={rate:this.rate};return Object.assign(t,e),t}call(e,t){return wn((()=>{this.invokeCallHook(e,t);const n=Mc(e);if(this.rate>0&&this.rate<1){return dc((()=>{const e=Math.sqrt(this.rate/(1-this.rate));return Ta(n,rc(n.shape,1,e))}),(()=>n),t.training||!1)}return n}))}}bf.className="GaussianDropout",ka(bf);class wf extends Zc{constructor(e){super(e),this.supportsMasking=!0,this.rate=e.rate,this.noiseShape=e.noiseShape}_getNoiseShape(e){return this.noiseShape||Mc(e).shape}computeOutputShape(e){return e}getConfig(){const e=super.getConfig(),t={rate:this.rate};return Object.assign(t,e),t}call(e,t){return wn((()=>{if(this.rate<1&&this.rate>0){const n=this._getNoiseShape(e);return dc((()=>{const t=Mc(e),a=-1.7580993408473766;let i=Ki(Ks(n),this.rate);i=Ql(i,"float32");const s=((1-this.rate)*(1+this.rate*a**2))**-.5,r=-s*a*this.rate,o=xa(Ta(t,i),Ta(xa(i,-1),a));return xa(Ta(o,s),r)}),(()=>Mc(e)),t.training||!1)}return e}))}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function kf(e,t,n,a,i,s=.001){let r;if(2===e.rank)r=Ha(e,t,n,a,i,s);else if(3===e.rank)r=Ja(e,t,n,a,i,s);else{if(4!==e.rank)throw new sl(`batchNormalization is not implemented for array of rank ${e.rank} yet`);r=Za(e,t,n,a,i,s)}return r}function xf(e,t,n,a,i=.001){return T(a.slice().sort(),Jl(0,e.rank-1))?function(e,t,n,a,i=.001){return wn((()=>{const s=ps(e,a),r=s.mean,o=s.variance;return[kf(e,r,o,n,t,i),r,o]}))}(e,t,n,a,i):function(e,t,n,a,i=.001){return wn((()=>{const s=ps(e,a),r=s.mean,o=s.variance,l=[];for(const t of Jl(0,e.rank))-1!==a.indexOf(t)?l.push(1):l.push(e.shape[t]);const c=Ma(r,l),u=Ma(o,l),h=null==t?null:Ma(t,l),p=null==n?null:Ma(n,l);return[kf(e,c,u,p,h,i),r,o]}))}(e,t,n,a,i)}wf.className="AlphaDropout",ka(wf);class Sf extends Zc{constructor(e){null==e&&(e={}),super(e),this.supportsMasking=!0,this.axis=null==e.axis?-1:e.axis,this.momentum=null==e.momentum?.99:e.momentum,this.epsilon=null==e.epsilon?.001:e.epsilon,this.center=null==e.center||e.center,this.scale=null==e.scale||e.scale,this.betaInitializer=_c(e.betaInitializer||"zeros"),this.gammaInitializer=_c(e.gammaInitializer||"ones"),this.movingMeanInitializer=_c(e.movingMeanInitializer||"zeros"),this.movingVarianceInitializer=_c(e.movingVarianceInitializer||"ones"),this.betaConstraint=Ah(e.betaConstraint),this.gammaConstraint=Ah(e.gammaConstraint),this.betaRegularizer=hd(e.betaRegularizer),this.gammaRegularizer=hd(e.gammaRegularizer)}build(e){e=Oc(e);const t=this.axis>=0?this.axis:this.axis+e.length,n=e[t];if(null==n)throw new il(`Axis ${t} of input tensor should have a defined dimension but the layer received an input with shape ${JSON.stringify(e)}.`);this.inputSpec=[new Vc({ndim:e.length,axes:{[t]:n}})];const a=[n];this.scale&&(this.gamma=this.addWeight("gamma",a,null,this.gammaInitializer,this.gammaRegularizer,!0,this.gammaConstraint)),this.center&&(this.beta=this.addWeight("beta",a,null,this.betaInitializer,this.betaRegularizer,!0,this.betaConstraint)),this.movingMean=this.addWeight("moving_mean",a,null,this.movingMeanInitializer,null,!1),this.movingVariance=this.addWeight("moving_variance",a,null,this.movingVarianceInitializer,null,!1),this.built=!0}call(e,t){return wn((()=>{const n=null!=t.training&&t.training,a=Mc(e),i=a.shape,s=i.length,r=Jl(0,s),o=this.axis>=0?this.axis:this.axis+s;r.splice(o,1);const l=ll(1,s);l[o]=i[o];const c=r.slice();c.sort();const u=!T(c,Jl(0,s).slice(0,s-1));if(!n)return(()=>{if(u){const e=Ma(this.movingMean.read(),l),t=Ma(this.movingVariance.read(),l),n=this.center?Ma(this.beta.read(),l):null,i=this.scale?Ma(this.gamma.read(),l):null;return kf(a,e,t,n,i,this.epsilon)}return kf(a,this.movingMean.read(),this.movingVariance.read(),null==this.beta?null:this.beta.read(),null==this.gamma?null:this.gamma.read(),this.epsilon)})();const[h,p,d]=xf(a,this.gamma.read(),this.beta.read(),r,this.epsilon),f=(e,t,n)=>{wn((()=>{const a=1-n,i=e.read(),s=Ta(es(i,t),a);e.write(es(i,s))}))};return(()=>{f(this.movingMean,p,this.momentum),f(this.movingVariance,d,this.momentum)})(),h}))}getConfig(){const e={axis:this.axis,momentum:this.momentum,epsilon:this.epsilon,center:this.center,scale:this.scale,betaInitializer:Fc(this.betaInitializer),gammaInitializer:Fc(this.gammaInitializer),movingMeanInitializer:Fc(this.movingMeanInitializer),movingVarianceInitializer:Fc(this.movingVarianceInitializer),betaRegularizer:cd(this.betaRegularizer),gammaRegularizer:cd(this.gammaRegularizer),betaConstraint:Ch(this.betaConstraint),gammaConstraint:Ch(this.gammaConstraint)},t=super.getConfig();return Object.assign(e,t),e}}Sf.className="BatchNormalization",ka(Sf);class Nf extends Zc{constructor(e){if(null==e&&(e={}),super(e),this.axis=null==e.axis?-1:e.axis,"number"==typeof this.axis){if(!Number.isInteger(this.axis))throw new Error(`Expected axis to be an integer, but received ${this.axis}`)}else{if(!Array.isArray(this.axis))throw new Error(`Expected axis to be an integer or an array of integers, but received ${JSON.stringify(this.axis)}`);for(const e of this.axis)if(!Number.isInteger(e))throw new Error(`Expected axis to be an array of integers, but received ${JSON.stringify(this.axis)}`)}this.epsilon=null==e.epsilon?.001:e.epsilon,this.center=null==e.center||e.center,this.scale=null==e.scale||e.scale,this.betaInitializer=_c(e.betaInitializer||"zeros"),this.gammaInitializer=_c(e.gammaInitializer||"ones"),this.betaRegularizer=hd(e.betaRegularizer),this.gammaRegularizer=hd(e.gammaRegularizer),this.supportsMasking=!0}build(e){const t=(e=Oc(e)).length;"number"==typeof this.axis&&(this.axis=[this.axis]);for(let e=0;e<this.axis.length;++e)this.axis[e]<0&&(this.axis[e]+=t);for(const e of this.axis)if(e<0||e>=t)throw new Error(`Invalid axis: ${e}`);if(this.axis.length!==wl(this.axis).length)throw new Error(`Found duplicate axes in: ${this.axis}`);const n=this.axis.map((t=>e[t])),a=!0;this.scale?this.gamma=this.addWeight("gamma",n,"float32",this.gammaInitializer,this.gammaRegularizer,a):this.gamma=null,this.center?this.beta=this.addWeight("beta",n,"float32",this.betaInitializer,this.betaRegularizer,a):this.beta=null,this.built=!0}call(e,t){const n=Mc(e),a=n.shape,i=a.length;return wn((()=>{let{mean:e,variance:t}=ps(n,this.axis,!0);const s=ll(1,i);for(const e of this.axis)s[e]=a[e];const r=e=>null!=e&&e.shape.length!==i?Ma(e,s):e;let o=this.scale?r(this.gamma.read()):null,l=this.center?r(this.beta.read()):null;const c=[],u=[];for(let e=0;e<i;++e)-1!==this.axis.indexOf(e)?(c.push(a[e]),u.push(1)):(c.push(1),u.push(a[e]));return e=Bi(e,c),t=Bi(t,c),null!=o&&(o=Bi(o,u)),null!=l&&(l=Bi(l,u)),kf(n,e,t,l,o,this.epsilon)}))}getConfig(){const e={axis:this.axis,epsilon:this.epsilon,center:this.center,scale:this.scale,betaInitializer:Fc(this.betaInitializer),gammaInitializer:Fc(this.gammaInitializer),betaRegularizer:cd(this.betaRegularizer),gammaRegularizer:cd(this.gammaRegularizer)},t=super.getConfig();return Object.assign(e,t),e}}Nf.className="LayerNormalization",ka(Nf);class Tf extends Zc{constructor(e){if(null==e&&(e={}),super(e),this.dataFormat=null==e.dataFormat?"channelsLast":e.dataFormat,null==e.padding)this.padding=[[1,1],[1,1]];else if("number"==typeof e.padding)this.padding=[[e.padding,e.padding],[e.padding,e.padding]];else{if(e.padding=e.padding,2!==e.padding.length)throw new il(`ZeroPadding2D expects padding to be a length-2 array, but received a length-${e.padding.length} array.`);let t,n;if("number"==typeof e.padding[0])t=[e.padding[0],e.padding[0]],n=[e.padding[1],e.padding[1]];else{if(e.padding=e.padding,2!==e.padding[0].length)throw new il(`ZeroPadding2D expects height padding to be a length-2 array, but received a length-${e.padding[0].length} array.`);if(t=e.padding[0],2!==e.padding[1].length)throw new il(`ZeroPadding2D expects width padding to be a length-2 array, but received a length-${e.padding[1].length} array.`);n=e.padding[1]}this.padding=[t,n]}this.inputSpec=[new Vc({ndim:4})]}computeOutputShape(e){let t,n;return e=Oc(e),"channelsFirst"===this.dataFormat?(t=null!=e[2]&&e[2]>=0?e[2]+this.padding[0][0]+this.padding[0][1]:null,n=null!=e[3]&&e[3]>=0?e[3]+this.padding[1][0]+this.padding[1][1]:null,[e[0],e[1],t,n]):(t=null!=e[1]&&e[1]>=0?e[1]+this.padding[0][0]+this.padding[0][1]:null,n=null!=e[2]&&e[2]>=0?e[2]+this.padding[1][0]+this.padding[1][1]:null,[e[0],t,n,e[3]])}call(e,t){return wn((()=>{return t=Mc(e),n=this.padding,a=this.dataFormat,wn((()=>{if(4!==t.rank)throw new il(`temporalPadding expects input tensor to be 4-D, but received a ${t.rank}-D tensor.`);if(null==n&&(n=[[1,1],[1,1]]),2!==n.length||2!==n[0].length||2!==n[1].length)throw new il("spatial2dPadding expects `padding` to be an Array of two Arrays, each of which is an Array of two integers.");if(null==a&&(a="channelsLast"),"channelsLast"!==a&&"channelsFirst"!==a)throw new il(`Unknown data format: ${a}. Supported data formats are 'channelsLast' and 'channelsFirst.`);let e;return e="channelsFirst"===a?[[0,0],[0,0],n[0],n[1]]:[[0,0],n[0],n[1],[0,0]],ms(t,e)}));
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
var t,n,a}))}getConfig(){const e={padding:this.padding,dataFormat:this.dataFormat},t=super.getConfig();return Object.assign(e,t),e}}
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
function If(e,t,n,a,i,s){return wn((()=>{let r;Ll(i),Ol(s),Ml(a),null==n&&(n=[1,1]),null==a&&(a="valid"),null==i&&(i="channelsLast"),null==s&&(s="max"),e=kd(e,i);const o="same"===a?"same":"valid";return r="max"===s?ss(e,t,n,o):Oa(e,t,n,o),"channelsFirst"===i&&(r=pa(r,[0,3,1,2])),r}))}function Cf(e,t,n,a,i,s){return wn((()=>{let r;Ll(i),Ol(s),Ml(a),null==n&&(n=[1,1,1]),null==a&&(a="valid"),null==i&&(i="channelsLast"),null==s&&(s="max"),e=xd(e,i);const o="same"===a?"same":"valid";return r="max"===s?rs(e,t,n,o):Pa(e,t,n,o),"channelsFirst"===i&&(r=pa(r,[0,4,1,2,3])),r}))}Tf.className="ZeroPadding2D",ka(Tf);class $f extends Zc{constructor(e){if(null==e.poolSize&&(e.poolSize=2),super(e),"number"==typeof e.poolSize)this.poolSize=[e.poolSize];else{if(!Array.isArray(e.poolSize)||1!==e.poolSize.length||"number"!=typeof e.poolSize[0])throw new il(`poolSize for 1D convolutional layer must be a number or an Array of a single number, but received ${JSON.stringify(e.poolSize)}`);this.poolSize=e.poolSize}if(Nl(this.poolSize,"poolSize"),null==e.strides)this.strides=this.poolSize;else if("number"==typeof e.strides)this.strides=[e.strides];else{if(!Array.isArray(e.strides)||1!==e.strides.length||"number"!=typeof e.strides[0])throw new il(`strides for 1D convolutional layer must be a number or an Array of a single number, but received ${JSON.stringify(e.strides)}`);this.strides=e.strides}Nl(this.strides,"strides"),this.padding=null==e.padding?"valid":e.padding,Ml(this.padding),this.inputSpec=[new Vc({ndim:3})]}computeOutputShape(e){const t=bd((e=Oc(e))[1],this.poolSize[0],this.padding,this.strides[0]);return[e[0],t,e[2]]}call(e,t){return wn((()=>{this.invokeCallHook(e,t),e=Xl(Mc(e),2);const n=this.poolingFunction(Mc(e),[this.poolSize[0],1],[this.strides[0],1],this.padding,"channelsLast");return cr(n,[2])}))}getConfig(){const e={poolSize:this.poolSize,padding:this.padding,strides:this.strides},t=super.getConfig();return Object.assign(e,t),e}}class Af extends $f{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),If(e,t,n,a,i,"max")}}Af.className="MaxPooling1D",ka(Af);class Ef extends $f{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),If(e,t,n,a,i,"avg")}}Ef.className="AveragePooling1D",ka(Ef);class jf extends Zc{constructor(e){if(null==e.poolSize&&(e.poolSize=[2,2]),super(e),this.poolSize=Array.isArray(e.poolSize)?e.poolSize:[e.poolSize,e.poolSize],null==e.strides)this.strides=this.poolSize;else if(Array.isArray(e.strides)){if(2!==e.strides.length)throw new il(`If the strides property of a 2D pooling layer is an Array, it is expected to have a length of 2, but received length ${e.strides.length}.`);this.strides=e.strides}else this.strides=[e.strides,e.strides];Nl(this.poolSize,"poolSize"),Nl(this.strides,"strides"),this.padding=null==e.padding?"valid":e.padding,this.dataFormat=null==e.dataFormat?"channelsLast":e.dataFormat,Ll(this.dataFormat),Ml(this.padding),this.inputSpec=[new Vc({ndim:4})]}computeOutputShape(e){e=Oc(e);let t="channelsFirst"===this.dataFormat?e[2]:e[1],n="channelsFirst"===this.dataFormat?e[3]:e[2];return t=bd(t,this.poolSize[0],this.padding,this.strides[0]),n=bd(n,this.poolSize[1],this.padding,this.strides[1]),"channelsFirst"===this.dataFormat?[e[0],e[1],t,n]:[e[0],t,n,e[3]]}call(e,t){return wn((()=>(this.invokeCallHook(e,t),this.poolingFunction(Mc(e),this.poolSize,this.strides,this.padding,this.dataFormat))))}getConfig(){const e={poolSize:this.poolSize,padding:this.padding,strides:this.strides,dataFormat:this.dataFormat},t=super.getConfig();return Object.assign(e,t),e}}class zf extends jf{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),If(e,t,n,a,i,"max")}}zf.className="MaxPooling2D",ka(zf);class Df extends jf{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),If(e,t,n,a,i,"avg")}}Df.className="AveragePooling2D",ka(Df);class Ff extends Zc{constructor(e){if(null==e.poolSize&&(e.poolSize=[2,2,2]),super(e),this.poolSize=Array.isArray(e.poolSize)?e.poolSize:[e.poolSize,e.poolSize,e.poolSize],null==e.strides)this.strides=this.poolSize;else if(Array.isArray(e.strides)){if(3!==e.strides.length)throw new il(`If the strides property of a 3D pooling layer is an Array, it is expected to have a length of 3, but received length ${e.strides.length}.`);this.strides=e.strides}else this.strides=[e.strides,e.strides,e.strides];Nl(this.poolSize,"poolSize"),Nl(this.strides,"strides"),this.padding=null==e.padding?"valid":e.padding,this.dataFormat=null==e.dataFormat?"channelsLast":e.dataFormat,Ll(this.dataFormat),Ml(this.padding),this.inputSpec=[new Vc({ndim:5})]}computeOutputShape(e){e=Oc(e);let t="channelsFirst"===this.dataFormat?e[2]:e[1],n="channelsFirst"===this.dataFormat?e[3]:e[2],a="channelsFirst"===this.dataFormat?e[4]:e[3];return t=bd(t,this.poolSize[0],this.padding,this.strides[0]),n=bd(n,this.poolSize[1],this.padding,this.strides[1]),a=bd(a,this.poolSize[2],this.padding,this.strides[2]),"channelsFirst"===this.dataFormat?[e[0],e[1],t,n,a]:[e[0],t,n,a,e[4]]}call(e,t){return wn((()=>(this.invokeCallHook(e,t),this.poolingFunction(Mc(e),this.poolSize,this.strides,this.padding,this.dataFormat))))}getConfig(){const e={poolSize:this.poolSize,padding:this.padding,strides:this.strides,dataFormat:this.dataFormat},t=super.getConfig();return Object.assign(e,t),e}}class _f extends Ff{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),Cf(e,t,n,a,i,"max")}}_f.className="MaxPooling3D",ka(_f);class Rf extends Ff{constructor(e){super(e)}poolingFunction(e,t,n,a,i){return Ll(i),Ml(a),Cf(e,t,n,a,i,"avg")}}Rf.className="AveragePooling3D",ka(Rf);class Lf extends Zc{constructor(e){super(e),this.inputSpec=[new Vc({ndim:3})]}computeOutputShape(e){return[e[0],e[2]]}call(e,t){throw new sl}}class Mf extends Lf{constructor(e){super(e||{})}call(e,t){return wn((()=>{const t=Mc(e);return ls(t,1)}))}}Mf.className="GlobalAveragePooling1D",ka(Mf);class Of extends Lf{constructor(e){super(e||{})}call(e,t){return wn((()=>{const t=Mc(e);return Ei(t,1)}))}}Of.className="GlobalMaxPooling1D",ka(Of);class Pf extends Zc{constructor(e){super(e),this.dataFormat=null==e.dataFormat?"channelsLast":e.dataFormat,Ll(this.dataFormat),this.inputSpec=[new Vc({ndim:4})]}computeOutputShape(e){return"channelsLast"===this.dataFormat?[e[0],e[3]]:[e[0],e[1]]}call(e,t){throw new sl}getConfig(){const e={dataFormat:this.dataFormat},t=super.getConfig();return Object.assign(e,t),e}}class Bf extends Pf{call(e,t){return wn((()=>{const t=Mc(e);return"channelsLast"===this.dataFormat?ls(t,[1,2]):ls(t,[2,3])}))}}Bf.className="GlobalAveragePooling2D",ka(Bf);class Uf extends Pf{call(e,t){return wn((()=>{const t=Mc(e);return"channelsLast"===this.dataFormat?Ei(t,[1,2]):Ei(t,[2,3])}))}}Uf.className="GlobalMaxPooling2D",ka(Uf);
/**
     * @license
     * Copyright 2018 Google LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class Wf extends Zc{constructor(e){super(e),this.layer=e.layer}build(e){this.built=!0}get trainable(){return null!=this.layer&&this.layer.trainable}set trainable(e){null!=this.layer&&(this.layer.trainable=e)}get trainableWeights(){return this.layer.trainableWeights}get nonTrainableWeights(){return this.layer.nonTrainableWeights}get updates(){return this.layer._updates}get losses(){return this.layer.losses}getWeights(){return this.layer.getWeights()}setWeights(e){this.layer.setWeights(e)}getConfig(){const e={layer:{className:this.layer.getClassName(),config:this.layer.getConfig()}},t=super.getConfig();return Object.assign(e,t),e}setFastWeightInitDuringBuild(e){super.setFastWeightInitDuringBuild(e),null!=this.layer&&this.layer.setFastWeightInitDuringBuild(e)}static fromConfig(e,t,n={}){const a=Bh(t.layer,n);delete t.layer;const i={layer:a};return Object.assign(i,t),new e(i)}}class Gf extends Wf{constructor(e){super(e),this.supportsMasking=!0}build(e){if((e=Oc(e)).length<3)throw new il(`TimeDistributed layer expects an input shape >= 3D, but received input shape ${JSON.stringify(e)}`);this.inputSpec=[{shape:e}];const t=[e[0]].concat(e.slice(2));this.layer.built||(this.layer.build(t),this.layer.built=!0),super.build(e)}computeOutputShape(e){const t=[(e=Oc(e))[0]].concat(e.slice(2)),n=this.layer.computeOutputShape(t),a=e[1];return[n[0],a].concat(n.slice(1))}call(e,t){return wn((()=>Ld(((e,n)=>[Mc(this.layer.call(e,t)),[]]),e=Mc(e),[],!1,null,0,!1,!0)[1]))}}Gf.className="TimeDistributed",ka(Gf);class Vf extends Wf{constructor(e){super(e);const t=e.layer.getConfig(),n={};n.className=e.layer.getClassName(),n.config=t,this.forwardLayer=Bh(n),t.goBackwards=!0!==t.goBackwards;const a={};var i;if(a.className=e.layer.getClassName(),a.config=t,this.backwardLayer=Bh(a),this.forwardLayer.name="forward_"+this.forwardLayer.name,this.backwardLayer.name="backward_"+this.backwardLayer.name,this.mergeMode=void 0===e.mergeMode?"concat":e.mergeMode,i=this.mergeMode,xl(_l,"BidirectionalMergeMode",i),e.weights)throw new sl("weights support is not implemented for Bidirectional layer yet.");this._stateful=e.layer.stateful,this.returnSequences=e.layer.returnSequences,this.returnState=e.layer.returnState,this.supportsMasking=!0,this._trainable=!0,this.inputSpec=e.layer.inputSpec,this.numConstants=null}get trainable(){return this._trainable}set trainable(e){this._trainable=e,null!=this.forwardLayer&&(this.forwardLayer.trainable=e),null!=this.backwardLayer&&(this.backwardLayer.trainable=e)}getWeights(){return this.forwardLayer.getWeights().concat(this.backwardLayer.getWeights())}setWeights(e){const t=e.length,n=Math.floor(t/2);this.forwardLayer.setWeights(e.slice(0,n)),this.backwardLayer.setWeights(e.slice(n))}computeOutputShape(e){let t,n,a,i=this.forwardLayer.computeOutputShape(e);return Array.isArray(i)&&Array.isArray(i[0])||(i=[i]),this.returnState?(a=i.slice(1),t=i[0]):t=i[0],"concat"===this.mergeMode?(t[t.length-1]*=2,n=[t]):n=null==this.mergeMode?[t,t.slice()]:[t],this.returnState?null==this.mergeMode?n.concat(a).concat(a.slice()):[t].concat(a).concat(a.slice()):hl(n)}apply(e,t){let n=null==t?null:t.initialState,a=null==t?null:t.constants;null==t&&(t={});const i=Rd(e,n,a,this.numConstants);if(e=i.inputs,n=i.initialState,a=i.constants,Array.isArray(e)&&(n=e.slice(1),e=e[0]),(null==n||0===n.length)&&null==a)return super.apply(e,t);const s=[],r=[];if(null!=n){const e=n.length;if(e%2>0)throw new il("When passing `initialState` to a Bidrectional RNN, the state should be an Array containing the states of the underlying RNNs.");t.initialState=n,s.push(...n);const a=n.map((e=>new Vc({shape:e.shape})));this.forwardLayer.stateSpec=a.slice(0,e/2),this.backwardLayer.stateSpec=a.slice(e/2),r.push(...a)}if(null!=a)throw new sl("Support for constants in Bidirectional layers is not implemented yet.");const o=s[0]instanceof Kc;for(const e of s)if(e instanceof Kc!==o)throw new il("The initial state of a Bidirectional layer cannot be specified as a mix of symbolic and non-symbolic tensors");if(o){const n=[e].concat(s),a=this.inputSpec.concat(r),i=this.inputSpec;this.inputSpec=a;const o=super.apply(n,t);return this.inputSpec=i,o}return super.apply(e,t)}call(e,t){return wn((()=>{const n=t.initialState;let a,i,s,r;if(null==n)a=this.forwardLayer.call(e,t),i=this.backwardLayer.call(e,t);else{const s=n.slice(0,n.length/2),r=n.slice(n.length/2);a=this.forwardLayer.call(e,Object.assign(t,{initialState:s})),i=this.backwardLayer.call(e,Object.assign(t,{initialState:r}))}return this.returnState&&(Array.isArray(a)&&(s=a.slice(1).concat(i.slice(1))),a=a[0],i=i[0]),this.returnSequences&&(i=Zs(i,1)),"concat"===this.mergeMode?r=ac([a,i]):"sum"===this.mergeMode?r=xa(a,i):"ave"===this.mergeMode?r=Ta(.5,xa(a,i)):"mul"===this.mergeMode?r=Ta(a,i):null==this.mergeMode&&(r=[a,i]),this.returnState?null==this.mergeMode?r.concat(s):[r].concat(s):r}))}resetStates(e){this.forwardLayer.resetStates(),this.backwardLayer.resetStates()}build(e){Bl(this.forwardLayer.name,(()=>{this.forwardLayer.build(e)})),Bl(this.backwardLayer.name,(()=>{this.backwardLayer.build(e)})),this.built=!0}computeMask(e,t){let n;if(Array.isArray(t)&&(t=t[0]),n=this.returnSequences?null==this.mergeMode?[t,t]:t:null==this.mergeMode?[null,null]:null,this.returnState){const e=this.forwardLayer.states.map((e=>null));return Array.isArray(n)?n.concat(e).concat(e):[n].concat(e).concat(e)}return n}get trainableWeights(){return this.forwardLayer.trainableWeights.concat(this.backwardLayer.trainableWeights)}get nonTrainableWeights(){return this.forwardLayer.nonTrainableWeights.concat(this.backwardLayer.nonTrainableWeights)}setFastWeightInitDuringBuild(e){super.setFastWeightInitDuringBuild(e),null!=this.forwardLayer&&this.forwardLayer.setFastWeightInitDuringBuild(e),null!=this.backwardLayer&&this.backwardLayer.setFastWeightInitDuringBuild(e)}getConfig(){const e={mergeMode:this.mergeMode},t=super.getConfig();return Object.assign(e,t),e}static fromConfig(e,t){const n=Bh(t.layer);if(delete t.layer,null!=t.numConstants)throw new sl("Deserialization of a Bidirectional layer with numConstants present is not supported yet.");const a=t;return a.layer=n,new e(a)}}Vf.className="Bidirectional",ka(Vf);
/**
     * @license
     * Copyright 2022 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class Kf extends Zc{constructor(e){super(e),this.scale=e.scale,e.offset?this.offset=e.offset:this.offset=0}getConfig(){const e={scale:this.scale,offset:this.offset},t=super.getConfig();return Object.assign(e,t),e}call(e,t){return wn((()=>("float32"!==(e=Mc(e)).dtype&&(e=Ql(e,"float32")),xa(Ta(e,this.scale),this.offset))))}}Kf.className="Rescaling",ka(Kf);
/**
     * @license
     * Copyright 2022 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
const{resizeBilinear:qf,cropAndResize:Hf}=Zr;class Jf extends Zc{constructor(e){super(e),this.height=e.height,this.width=e.width}centerCrop(e,t,n,a,i,s,r,o){return wn((()=>{let l,c=!1;const u=[t/s,n/r,(a+t)/s,(i+n)/r],h=[];3===e.rank?(c=!0,l=ur([e])):l=e;for(let e=0;e<l.shape[0];e++)h.push(u);const p=mn(h,[h.length,4]),d=qs(0,h.length,1,"int32"),f=Hf(l,p,d,[a,i],"nearest");return Ql(c?Mc(gr(f)):f,o)}))}upsize(e,t,n,a){return wn((()=>Ql(qf(e,[t,n]),a)))}call(e,t){return wn((()=>{const t=Mc(e),n=t.dtype,a=t.shape,i=a[a.length-3],s=a[a.length-2];let r=0;i!==this.height&&(r=Math.floor((i-this.height)/2));let o=0;return s!==this.width&&(o=Math.floor((s-this.width)/2),0===o&&(o=1)),r>=0&&o>=0?this.centerCrop(t,r,o,this.height,this.width,i,s,n):this.upsize(e,this.height,this.width,n)}))}getConfig(){const e={height:this.height,width:this.width},t=super.getConfig();return Object.assign(e,t),e}computeOutputShape(e){const t=(e=Oc(e)).length-3,n=e.length-2;return e[t]=this.height,e[n]=this.width,e}}Jf.className="CenterCrop",ka(Jf);
/**
     * @license
     * Copyright 2022 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class Zf extends Zc{constructor(e){super(e),this.numTokens=e.numTokens,e.outputMode?this.outputMode=e.outputMode:this.outputMode="multiHot"}getConfig(){const e={numTokens:this.numTokens,outputMode:this.outputMode},t=super.getConfig();return Object.assign(e,t),e}computeOutputShape(e){return null==(e=Oc(e))?[this.numTokens]:"oneHot"===this.outputMode&&1!==e[e.length-1]?(e.push(this.numTokens),e):(e[e.length-1]=this.numTokens,e)}call(e,t){return wn((()=>{let n;if("int32"!==(e=Mc(e)).dtype&&(e=Ql(e,"int32")),void 0!==t.countWeights){if("count"!==this.outputMode)throw new il(`countWeights is not used when outputMode !== count.\n              Received countWeights=${t.countWeights}`);n=Mc(t.countWeights)}const a=Ei(e),i=ji(e),s=Vi(this.numTokens,a).bufferSync().get(0),r=Ki(i,0).bufferSync().get(0);if(!s||!r)throw new il(`Input values must be between 0 < values <= numTokens with numTokens=${this.numTokens}`);
/**
     * @license
     * Copyright 2022 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
return function(e,t,n,a){let i=Mc(e);if("int32"!==i.dtype&&(i=Ql(i,"int32")),"int"===t)return i;const s=i.shape;if(0===i.rank&&(i=Pi(i,-1)),"oneHot"===t&&1!==i.shape[i.shape.length-1]&&(i=Pi(i,-1)),i.rank>2)throw new il(`When outputMode is not int, maximum output rank is 2 Received outputMode ${t} and input shape ${s} which would result in output rank ${i.rank}.`);const r=["multiHot","oneHot"].includes(t);let o;if(o=vi(i,void 0!==a&&"count"===t?a:[],n,r),"tfIdf"!==t)return o;if(a)return Ta(o,a);throw new il("When outputMode is 'tfIdf', weights must be provided.")}(e,this.outputMode,this.numTokens,n)}))}}Zf.className="CategoryEncoding",ka(Zf);
/**
     * @license
     * Copyright 2022 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
const Yf=new Set(["bilinear","nearest"]);class Qf extends Zc{constructor(e){if(super(e),this.height=e.height,this.width=e.width,e.interpolation){if(!Yf.has(e.interpolation))throw new il(`Invalid interpolation parameter: ${e.interpolation} is not implemented`);this.interpolation=e.interpolation}else this.interpolation="bilinear";this.cropToAspectRatio=Boolean(e.cropToAspectRatio)}computeOutputShape(e){const t=(e=Oc(e))[2];return[this.height,this.width,t]}getConfig(){const e={height:this.height,width:this.width,interpolation:this.interpolation,cropToAspectRatio:this.cropToAspectRatio},t=super.getConfig();return Object.assign(e,t),e}call(e,t){return wn((()=>{const t=[this.height,this.width];if("bilinear"===this.interpolation)return Zr.resizeBilinear(e,t,!this.cropToAspectRatio);if("nearest"===this.interpolation)return Zr.resizeNearestNeighbor(e,t,!this.cropToAspectRatio);throw new Error(`Interpolation is ${this.interpolation} but only ${[...Yf]} are supported`)}))}}Qf.className="Resizing",ka(Qf);
/**
     * @license
     * Copyright 2023 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class Xf{constructor(e){this.seed=e}next(){if(void 0!==this.seed)return this.seed++}}Xf.className="RandomSeed";
/**
     * @license
     * Copyright 2023 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
class em extends Zc{constructor(e){super(e),this.randomGenerator=new Xf(e.seed)}getConfig(){const e={seed:this.randomGenerator.seed},t=super.getConfig();return Object.assign(e,t),e}}em.className="BaseRandomLayer";
/**
     * @license
     * Copyright 2023 CodeSmith LLC
     *
     * Use of this source code is governed by an MIT-style
     * license that can be found in the LICENSE file or at
     * https://opensource.org/licenses/MIT.
     * =============================================================================
     */
const tm=new Set(["bilinear","nearest"]);class nm extends em{constructor(e){super(e);const{factor:t,interpolation:n="bilinear"}=e;if(this.factor=t,Array.isArray(this.factor)&&2===this.factor.length)this.widthLower=this.factor[0],this.widthUpper=this.factor[1];else{if(Array.isArray(this.factor)||!(this.factor>0))throw new il(`Invalid factor: ${this.factor}. Must be positive number or tuple of 2 numbers`);this.widthLower=-this.factor,this.widthUpper=this.factor}if(this.widthLower<-1||this.widthUpper<-1)throw new il(`factor must have values larger than -1. Got: ${this.factor}`);if(this.widthUpper<this.widthLower)throw new il(`factor cannot have upper bound less than lower bound.\n        Got upper bound: ${this.widthUpper}.\n        Got lower bound: ${this.widthLower}\n      `);if(n){if(!tm.has(n))throw new il(`Invalid interpolation parameter: ${n} is not implemented`);this.interpolation=n}}getConfig(){const e={factor:this.factor,interpolation:this.interpolation},t=super.getConfig();return Object.assign(e,t),e}computeOutputShape(e){const t=(e=Oc(e))[2];return[this.imgHeight,-1,t]}call(e,t){return wn((()=>{const t=Mc(e);this.imgHeight=t.shape[t.shape.length-3];const n=t.shape[t.shape.length-2];this.widthFactor=Ks([1],1+this.widthLower,1+this.widthUpper,"float32",this.randomGenerator.next());let a=this.widthFactor.dataSync()[0]*n;a=Math.round(a);const i=[this.imgHeight,a];switch(this.interpolation){case"bilinear":return Zr.resizeBilinear(e,i);case"nearest":return Zr.resizeNearestNeighbor(e,i);default:throw new Error(`Interpolation is ${this.interpolation}\n          but only ${[...tm]} are supported`)}}))}}nm.className="RandomWidth",ka(nm),
/**
     * @license
     * Copyright 2023 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */
vt(Uo),vt(Co),vt(Go),vt(Vo),vt(Ko),vt(qo),vt(Lo),vt(Ho),vt(tl),vt(Fo),vt(Qo),vt(Oo),vt(To);var am={"штих":"noun","пяних":"noun","белих":"adjective","борзих":"adjective","малих":"adjective","старих":"adjective","дарнопих":"noun","сухих":"adjective","черемних":"noun","сирих":"adjective","плохих":"adjective","целих":"adjective","жих":"noun","войцих":"noun","скорих":"adjective","бурих":"adjective","чалих":"adjective","серих":"adjective","удалих":"adjective","карих":"adjective","гених":"noun","литвих":"noun","марцих":"noun","сізих":"adjective","яних":"noun","мжачих":"adjective","сірих":"adjective","янбих":"noun","бодрих":"adjective","стрий":"noun","чорторий":"noun","юрий":"adjective","цибрий":"noun","цібрий":"noun","карий":"adjective","куприй":"noun","кирий":"noun","негрий":"noun","губрий":"noun","шкабрий":"noun","замрий":"noun","передрий":"noun","одерий":"noun","жегрий":"noun","жарий":"adjective","зюбрий":"noun","семерий":"noun","лий":"noun","бий":"noun","рий":"noun","вий":"noun","ший":"noun","валий":"noun","крайній":"adjective","осінній":"adjective","кутній":"adjective","середній":"adjective","горішній":"adjective","безродній":"adjective","осадчій":"adjective","кий":"noun","новохатній":"adjective","очеретній":"adjective","рбий":"noun","закутній":"adjective","недавній":"adjective","порожній":"adjective","бокий":"noun","вчерашній":"adjective","огородній":"adjective","трощий":"noun","вчорашній":"adjective","житній":"adjective","нижній":"adjective","синій":"adjective","хорий":"noun","краснобокій":"adjective","хижній":"adjective","забродній":"adjective","калюжній":"adjective","виноградній":"adjective","коломий":"noun","летучій":"adjective","поздній":"adjective","серий":"noun","нагорній":"adjective","фартушній":"adjective","холошвій":"noun","батий":"noun","волошиній":"adjective","жирий":"noun","заможній":"adjective","короткій":"adjective","останній":"adjective","передній":"adjective","піддубній":"adjective","пізній":"adjective","погородній":"adjective","бояжній":"adjective","смий":"noun","задвірній":"adjective","остатній":"adjective","підсадній":"adjective","достатній":"adjective","зимній":"adjective","рябой":"adjective","рудой":"adjective","козодой":"noun","яровой":"adjective","кривой":"adjective","садовой":"adjective","полевой":"adjective","сисой":"noun","плохой":"adjective","сухой":"adjective","гаєвой":"adjective","глухой":"adjective","горевой":"adjective","кутовой":"adjective","копаной":"adjective","злой":"adjective","сєдой":"adjective","благой":"adjective","водостой":"noun","косой":"adjective","ліждвой":"noun","большой":"adjective","половой":"adjective","чорной":"adjective","косогой":"adjective","золотой":"adjective","лановой":"adjective","яловой":"adjective","дорогой":"adjective","німой":"adjective","первой":"adjective","русой":"adjective","худой":"adjective","цаподой":"noun","авасілой":"noun","валовой":"adjective","гнідой":"adjective","молокопой":"noun","золотобой":"noun","ярковой":"noun","аміхалакіой":"noun","седой":"adjective","крутой":"adjective","кучной":"adjective","слепой":"adjective","дурной":"adjective","молодой":"adjective","бухой":"adjective","самотній":"adjective","біла":"adjective","бура":"adjective","велика":"adjective","домовина":"noun","рослина":"noun","врецьона":"noun","глибока":"adjective","висока":"adjective","гладка":"adjective","грицина":"noun","гужва":"noun","ковінька":"noun","дика":"adjective","діброва":"noun","кицька":"noun","ківа":"noun","лепка":"adjective","островерха":"adjective","петрина":"noun","прудка":"adjective","семенина":"noun","турчина":"noun","чуприна":"noun","швидка":"adjective","щербина":"noun","яковина":"noun","синьоока":"adjective","крива":"adjective","сліпа":"adjective","глуха":"adjective","жовта":"adjective","добра":"adjective","хоробра":"adjective","сухоребра":"adjective","гарна":"adjective","мала":"adjective","весна":"noun","зла":"adjective","жива":"adjective","ніяка":"adjective","ціла":"adjective","молода":"adjective","далека":"adjective","золота":"adjective","жвава":"adjective","дорога":"adjective","коса":"adjective","литва":"noun","чужа":"adjective","тепла":"adjective","груба":"adjective","слава":"noun","брова":"noun","стара":"adjective","катерина":"noun","василина":"noun","нижня":"adjective","худа":"adjective","проста":"adjective","дівоча":"adjective","крута":"adjective","метка":"adjective","чорна":"adjective","сторона":"noun","невкрита":"adjective","руда":"adjective","темна":"adjective","проява":"noun","тиха":"adjective","божа":"adjective","весела":"adjective","бабина":"adjective","суха":"adjective","люта":"adjective","стіна":"noun","вража":"adjective","хороша":"adjective","легка":"adjective","козача":"adjective","польща":"noun","недужа":"adjective","розлога":"adjective","гаряча":"adjective","середня":"adjective","торішня":"adjective","сита":"adjective","гостра":"adjective","осіння":"adjective","невесела":"adjective","москва":"noun","широка":"adjective","половина":"noun","синя":"adjective","сира":"adjective","довга":"adjective","коротка":"adjective","лукава":"adjective","абияка":"adjective","королева":"noun","чайна":"adjective","сіра":"adjective","сутула":"adjective","сава":"noun","дебела":"adjective","мокра":"adjective","убога":"adjective","безрука":"adjective","димна":"adjective","мила":"adjective","боса":"adjective","гола":"adjective","красноока":"adjective","остання":"adjective","десна":"noun","житня":"adjective","тризна":"noun","цупка":"adjective","порожня":"adjective","ліва":"adjective","сьома":"adjective","вовна":"noun","сова":"noun","бела":"adjective","ряба":"adjective","гніда":"adjective","гожа":"adjective","кисла":"adjective","кутня":"adjective","огниста":"adjective","мудра":"adjective","дужа":"adjective","підстава":"noun","бодра":"adjective","бадьора":"adjective","кривохижа":"adjective","прихожа":"adjective","побожа":"adjective","пригожа":"adjective","петрунька":"noun","ковинька":"noun","кишинька":"noun","кропивянька":"noun","зеленька":"noun","лабунька":"noun","м'якенька":"adjective","бухонька":"noun","сиза":"adjective","маза":"adjective","блаза":"adjective","улина":"adjective","ейвена":"adjective","еремина":"adjective","ена":"adjective","клята":"adjective","периста":"adjective","працевита":"adjective","свіжа":"adjective","рижа":"adjective","копистира":"noun","скорина":"noun","більченя":"noun","кривошеня":"noun","нестереня":"noun","захарченя":"noun","войценя":"noun","протасеня":"noun","олещеня":"noun","денисеня":"noun","стрельченя":"noun","молодоженя":"noun","заграва":"noun","неменша":"adjective","неменьша":"adjective","меньша":"adjective","паший":"noun","пєша":"adjective","дзвінка":"adjective","пухка":"adjective","безпала":"adjective","вобла":"adjective","горжа":"adjective","горіла":"adjective","китаста":"adjective","лиса":"adjective","осадча":"adjective","пелехата":"adjective","підпала":"adjective","ставнича":"adjective","чала":"adjective","чубата":"adjective","целомудра":"adjective","кара":"adjective","коцупатра":"adjective","немудра":"adjective","шара":"adjective","шингира":"adjective","передера":"adjective","далекора":"adjective","жара":"adjective","яра":"adjective","золотопера":"adjective","остра":"adjective","хитра":"adjective","прозора":"adjective","карчинска":"adjective","гнила":"adjective","хижа":"adjective","крижа":"adjective","погоріла":"adjective","куца":"adjective","солодка":"adjective","безверха":"adjective","усата":"adjective","довгопола":"adjective","щербата":"adjective","пишна":"adjective","хоружа":"adjective","мирна":"adjective","долга":"adjective","бєла":"adjective","надточа":"adjective","гаркава":"adjective","мягка":"adjective","топча":"adjective","товста":"adjective","блага":"adjective","захожа":"adjective","боліла":"adjective","басиста":"adjective","басіста":"adjective","люба":"adjective","горбата":"adjective","драна":"adjective","куряча":"adjective","куса":"adjective","зайва":"adjective","кругла":"adjective","брижата":"adjective","скора":"adjective","плоха":"adjective","горяча":"adjective","тверда":"adjective","невідома":"adjective","картава":"adjective","горна":"adjective","черна":"adjective","гуржа":"adjective","гикава":"adjective","шита":"adjective","сєра":"adjective","сіда":"adjective","гнуча":"adjective","слизька":"adjective","бистра":"adjective","полева":"adjective","парубоча":"adjective","вібла":"adjective","мазна":"adjective","волохата":"adjective","шалена":"adjective","щира":"adjective","слаба":"adjective","суковата":"adjective","нища":"adjective","одинока":"adjective","сядриста":"adjective","яшна":"adjective","ракоча":"adjective","губата":"adjective","летуча":"adjective","патлата":"adjective","вяла":"adjective","гірна":"adjective","кіптіла":"adjective","кривовяза":"adjective","лиха":"adjective","подуфала":"adjective","буйна":"adjective","зайшла":"adjective","купрата":"adjective","мерзла":"adjective","варгата":"adjective","горда":"adjective","драпата":"adjective","загризла":"adjective","кичата":"adjective","оковита":"adjective","тлуста":"adjective","тонка":"adjective","коптіла":"adjective","погожа":"adjective","товстокора":"adjective","гладенька":"adjective","глубока":"adjective","періста":"adjective","виконавча":"adjective","кохана":"adjective","кризька":"adjective","німа":"adjective","росла":"adjective","некипіла":"adjective","плакуща":"adjective","похила":"adjective","строга":"adjective","богата":"adjective","заливча":"adjective","крамна":"adjective","поставнича":"adjective","безуса":"adjective","плоска":"adjective","сергата":"adjective","сухотепла":"adjective","толста":"adjective","шарпата":"adjective","безребра":"adjective","душна":"adjective","змерзла":"adjective","золотоверха":"adjective","наточа":"adjective","положа":"adjective","рокоча":"adjective","горлата":"adjective","скупа":"adjective","бібла":"adjective","ільніцка":"adjective","рогоча":"adjective","сміла":"adjective","щедра":"adjective","безклуба":"adjective","білоока":"adjective","шерстка":"adjective","безкишка":"adjective","летюча":"adjective","ловча":"adjective","піша":"adjective","раба":"adjective","суховерха":"adjective","тягла":"adjective","шаблиста":"adjective","шубала":"adjective","бедрата":"adjective","верлата":"adjective","галича":"adjective","запухла":"adjective","зубата":"adjective","кунта":"adjective","некрита":"adjective","пахуча":"adjective","теляча":"adjective","шпарка":"adjective","глива":"adjective","косата":"adjective","любима":"adjective","низька":"adjective","окрепка":"adjective","робоча":"adjective","слизькоуха":"adjective","хропата":"adjective","цівата":"adjective","шията":"adjective","безборода":"adjective","голоборода":"adjective","голомоза":"adjective","горєла":"adjective","єжела":"adjective","калиста":"adjective","корчиста":"adjective","курна":"adjective","надута":"adjective","пікуща":"adjective","погорела":"adjective","савіцка":"adjective","тупа":"adjective","дзяна":"adjective","жовкла":"adjective","колюча":"adjective","мазана":"adjective","сапата":"adjective","світа":"adjective","сухолитка":"adjective","цаберяба":"adjective","цвіла":"adjective","чупла":"adjective","асадча":"adjective","гарагата":"adjective","дзюбата":"adjective","долгопола":"adjective","жилава":"adjective","козина":"adjective","крепка":"adjective","ласа":"adjective","личката":"adjective","лобата":"adjective","льогка":"adjective","мишаста":"adjective","невмита":"adjective","перката":"adjective","рідка":"adjective","саплива":"adjective","тонкошкура":"adjective","цепла":"adjective","беззуба":"adjective","бушна":"adjective","бяла":"adjective","кріпка":"adjective","лакома":"adjective","майна":"adjective","нагла":"adjective","огніста":"adjective","осядла":"adjective","рабоча":"adjective","рапава":"adjective","розмаїта":"adjective","тупча":"adjective","ушата":"adjective","чорноока":"adjective","галянта":"adjective","голомовза":"adjective","одажа":"adjective","орлата":"adjective","пашиста":"adjective","пробита":"adjective","сепіта":"adjective","слабка":"adjective","цікава":"adjective","шамка":"adjective","шибиста":"adjective","баліцка":"adjective","бита":"adjective","боляча":"adjective","глабчаста":"adjective","гусліста":"adjective","деньдобра":"adjective","замліла":"adjective","лабата":"adjective","мяка":"adjective","несміла":"adjective","нєма":"adjective","обща":"adjective","одайна":"adjective","оката":"adjective","остиста":"adjective","пахуща":"adjective","пстра":"adjective","сладка":"adjective","храпата":"adjective","чесніша":"adjective","чула":"adjective","бідноша":"adjective","довгорука":"adjective","довгоша":"adjective","іваніцка":"adjective","корната":"adjective","кулява":"adjective","літуча":"adjective","марна":"adjective","медзата":"adjective","обмокла":"adjective","піджара":"adjective","побоча":"adjective","сагата":"adjective","удала":"adjective","усяка":"adjective","байдужа":"adjective","бескорса":"adjective","гірка":"adjective","главата":"adjective","горча":"adjective","горька":"adjective","добровольска":"adjective","довгопта":"adjective","досужа":"adjective","драпята":"adjective","камяна":"adjective","каправа":"adjective","киричата":"adjective","колота":"adjective","комарніцка":"adjective","люзна":"adjective","молодша":"adjective","неумита":"adjective","пересідла":"adjective","підла":"adjective","пухла":"adjective","семяниста":"adjective","сіроока":"adjective","стряпча":"adjective","твереза":"adjective","цибульска":"adjective","чарна":"adjective","ярка":"adjective","безгуба":"adjective","білоборода":"adjective","болєла":"adjective","бровата":"adjective","гікава":"adjective","голобока":"adjective","драбата":"adjective","жарка":"adjective","каплата":"adjective","кісла":"adjective","ковалевска":"adjective","ковальска":"adjective","козловска":"adjective","крилата":"adjective","куцка":"adjective","малоока":"adjective","мгка":"adjective","немята":"adjective","непроста":"adjective","нехороша":"adjective","пелихата":"adjective","підласа":"adjective","подпала":"adjective","руцка":"adjective","семениста":"adjective","услиста":"adjective","шорстка":"adjective","хила":"adjective","буката":"adjective","васалата":"adjective","вибла":"adjective","видойна":"adjective","виловата":"adjective","гарча":"adjective","горела":"adjective","дута":"adjective","зибла":"adjective","індича":"adjective","кальноока":"adjective","карнауха":"adjective","кривобедра":"adjective","кричфалуша":"adjective","кубата":"adjective","кужда":"adjective","ломана":"adjective","мацевита":"adjective","івашина":"noun","солоха":"adjective","перерва":"noun","проскура":"adjective","бова":"noun","сметана":"noun","дуброва":"noun","проскурня":"noun","родіна":"noun","єна":"noun","солонина":"noun","ліщина":"noun","лугина":"adjective","сосна":"noun","гавва":"noun","ужва":"noun","кулина":"adjective","халява":"noun","холява":"noun","підкова":"noun","крайня":"adjective","хохотва":"noun","цибулька":"noun","нікульча":"noun","кравчина":"noun","лупина":"adjective","лихошва":"noun","думбрава":"noun","плахотня":"adjective","покутня":"adjective","пона":"noun","семена":"noun","грона":"noun","єва":"noun","парасківа":"noun","шова":"noun","бурдужа":"adjective","козюберда":"adjective","говтва":"noun","приколота":"adjective","варнава":"noun","гурина":"adjective","рябокобила":"noun","кучина":"adjective","савва":"noun","кремена":"noun","малая":"adjective","горішня":"adjective","бурдюжа":"adjective","слаква":"noun","городня":"adjective","лиштва":"noun","цяцька":"noun","походня":"noun","недавня":"adjective","долішня":"adjective","марюхна":"noun","борона":"noun","колошва":"noun","семенча":"noun","затона":"noun","заплава":"noun","краснопера":"adjective","рибитва":"noun","сидора":"adjective","краплина":"noun","крутиголова":"noun","бакалина":"adjective","немна":"noun","очеретня":"adjective","пробийголова":"noun","мальона":"noun","сажина":"adjective","вчерашня":"adjective","бузина":"noun","забийворота":"noun","магльона":"noun","нейчева":"noun","потороча":"noun","ревіна":"noun","матьора":"adjective","святина":"noun","хіна":"noun","кожина":"adjective","наріжня":"noun","леона":"noun","передня":"adjective","савина":"adjective","сікачина":"noun","кльова":"noun","недолуга":"adjective","шкоропата":"noun","карасава":"noun","морева":"adjective","мустафіна":"noun","цьова":"noun","бубна":"noun","катона":"noun","міна":"noun","похвала":"noun","слоква":"noun","статіва":"noun","строна":"noun","вова":"noun","карева":"adjective","місюна":"noun","швая":"noun","бальва":"noun","вершина":"noun","врона":"noun","білокобила":"noun","гордина":"noun","кольва":"noun","льова":"noun","перекліта":"noun","основа":"noun","харена":"noun","борозна":"noun","будаква":"noun","каранікола":"noun","палесіка":"noun","рожина":"noun","штана":"noun","вицина":"noun","дубна":"noun","жовна":"noun","зіва":"noun","катарина":"noun","похмура":"adjective","фесина":"noun","шемена":"noun","галутва":"noun","зарева":"noun","ковальва":"noun","мирона":"noun","новосела":"noun","пачина":"adjective","совва":"noun","гіна":"noun","корона":"noun","новоженя":"noun","підберезня":"adjective","ряднина":"noun","сакська":"noun","канна":"noun","лукачина":"noun","плачінта":"noun","редьква":"noun","софина":"adjective","шатня":"adjective","блозва":"noun","вчорашня":"adjective","гриценя":"noun","куропатва":"noun","людва":"noun","стехна":"noun","парахоня":"noun","плєва":"noun","яворина":"noun","бендина":"noun","жовтонога":"adjective","конева":"adjective","мандалина":"noun","мацина":"noun","перезва":"noun","похвата":"noun","токмина":"noun","тюрина":"adjective","гицина":"noun","дзіна":"noun","куява":"noun","малонога":"adjective","стоколоса":"adjective","тимина":"adjective","біднина":"noun","вдовина":"adjective","лисохмара":"noun","микитина":"adjective","полівара":"noun","рибонька":"noun","ружина":"noun","тишина":"noun","цюрмаста":"noun","чалая":"adjective","васина":"noun","воїна":"noun","гулая":"noun","кова":"noun","она":"noun","палісіка":"noun","підошва":"noun","свидина":"noun","тирсина":"noun","хаврона":"noun","зона":"noun","кнзєва":"noun","розна":"adjective","ронжина":"noun","рудомина":"noun","сальва":"noun","скільсара":"noun","служала":"noun","фомина":"adjective","чупина":"adjective","шалупня":"noun","джупина":"noun","зоська":"noun","кузява":"noun","неледва":"noun","равва":"noun","разьва":"noun","шкорина":"noun","білозора":"adjective","бранціра":"noun","випна":"noun","галина":"adjective","мандаліна":"noun","мицька":"noun","мячина":"adjective","недосєка":"noun","пристая":"noun","м'яка":"adjective","вовчина":"noun","гринява":"noun","дівонька":"noun","ігіна":"noun","обійдихата":"noun","хижня":"adjective","челядина":"noun","янева":"adjective","голева":"adjective","дзюнька":"noun","дубрава":"noun","лигомина":"noun","мална":"noun","мархева":"noun","несправа":"noun","озява":"noun","панна":"noun","пупена":"noun","силява":"noun","сухокобила":"noun","цюрмоста":"noun","чевельча":"noun","чівільча":"noun","башева":"noun","бражна":"noun","варавва":"noun","волна":"noun","гольча":"noun","густа":"adjective","достатня":"adjective","зуграва":"noun","карапулька":"noun","кірна":"adjective","крапіва":"noun","луковина":"noun","мамона":"noun","мелещеня":"noun","мряна":"noun","параскева":"noun","похідня":"noun","пріхна":"noun","свтина":"noun","сьоська":"noun","терепіща":"noun","ціцяла":"noun","бодаква":"noun","гальвіта":"noun","деревенча":"noun","дона":"noun","дубена":"noun","задависвічка":"noun","йовва":"noun","капаціла":"noun","котельва":"noun","лісота":"noun","малюська":"noun","підсадня":"adjective","рєва":"noun","сувора":"adjective","хаджава":"noun","хомина":"adjective","псина":"noun","бобина":"noun","болотня":"adjective","бруква":"noun","кіона":"noun","ковбінька":"noun","кривонога":"adjective","лєва":"noun","мухина":"adjective","нефортуна":"noun","органіста":"noun","пасулька":"noun","пристава":"noun","бачина":"noun","безкорса":"adjective","бєлокобила":"noun","борзина":"noun","бружина":"noun","воротня":"adjective","гальона":"noun","голтва":"noun","горемульта":"noun","дацина":"noun","забанджала":"noun","злая":"adjective","кікена":"noun","коропатва":"noun","кузина":"adjective","лапунька":"noun","літава":"noun","мінчуна":"noun","на":"noun","ничая":"noun","новіцка":"adjective","пенькна":"noun","пухна":"noun","пуцята":"noun","рісна":"noun","розмаіта":"noun","румина":"adjective","свтна":"noun","сердита":"adjective","січінава":"noun","сментина":"noun","трізна":"noun","шкуропата":"noun","безхутра":"adjective","гальва":"noun","гнєда":"adjective","гребенча":"noun","гусонька":"noun","калабанька":"noun","козупляка":"noun","лапина":"adjective","мурина":"adjective","некульча":"noun","орона":"noun","парна":"adjective","пліва":"noun","приходька":"noun","сенина":"noun","солотва":"noun","тетева":"adjective","хавана":"noun","царева":"adjective","ахалая":"noun","варенька":"noun","варшава":"noun","вересоча":"noun","галунька":"noun","гліва":"noun","голина":"adjective","грузька":"adjective","гудина":"noun","євона":"noun","кірева":"adjective","кожем'яка":"noun","колоберда":"adjective","курінька":"noun","маржина":"noun","мигалина":"noun","мікава":"adjective","падва":"noun","паланичка":"adjective","палена":"adjective","подкова":"noun","ратушня":"adjective","селегейна":"noun","сминтина":"noun","сумина":"adjective","теміркая":"noun","ухата":"adjective","хавроня":"noun","холоста":"adjective","ціва":"noun","чернята":"noun","чикольва":"noun","шалина":"adjective","юдина":"adjective","адвена":"noun","балева":"adjective","брона":"noun","вербовата":"adjective","веремєва":"noun","волчаста":"adjective","гафина":"adjective","голутва":"noun","закрева":"noun","каджая":"noun","кальченя":"noun","капаниста":"adjective","кикина":"adjective","костерева":"noun","кривокобила":"noun","кулєва":"noun","лавна":"noun","маліцка":"adjective","молдова":"noun","моркова":"noun","пажина":"adjective","перевернихата":"noun","пилева":"adjective","піддубня":"adjective","постіва":"noun","пуста":"adjective","суботня":"adjective","фадеева":"adjective","ходаніцка":"adjective","хохітва":"noun","цибата":"adjective","черноока":"adjective","чкадуа":"noun","чокена":"noun","шепетина":"noun","шербина":"noun","яка":"adjective","ятва":"noun","безена":"noun","безшкура":"adjective","безязика":"adjective","белая":"adjective","берулава":"noun","бузна":"noun","бурсала":"noun","бучаста":"adjective","вчина":"noun","гапона":"noun","гернажа":"noun","гордуна":"noun","горсва":"noun","горясва":"noun","грицька":"noun","двіжона":"noun","задурня":"adjective","заслона":"noun","зачешигрива":"noun","йона":"noun","качна":"adjective","козовіта":"noun","криворота":"adjective","кур'ята":"noun","лозна":"adjective","люлява":"noun","лютая":"adjective","матухна":"noun","накутня":"adjective","плохая":"adjective","бухая":"adjective","самотня":"adjective","панібудьласка":"noun","яцина":"noun"};class im{encode(t){const n=new Uint8Array(1);switch(t.wordClass){case e.WordClass.NOUN:n[0]=1;break;case e.WordClass.ADJECTIVE:n[0]=0;break;default:throw new TypeError(`Invalid word class: "${t.wordClass}".`)}return n}decode(t){if(t.length<1||t.length>1)throw new RangeError("Invalid vector length.");const n=t[0];if(n<0||n>1)throw new RangeError("Invalid vector value.");return{wordClass:n>=.5?e.WordClass.NOUN:e.WordClass.ADJECTIVE}}}class sm{constructor(e,t=0){this.vectorSize=e,this.unknownCharcode=t}encode(e){var t;const a=new Uint8Array(this.vectorSize),i=e.slice(-this.vectorSize).toLowerCase().padStart(this.vectorSize,"-");for(let e=0;e<i.length;e+=1){const s=i[e];a[e]=null!==(t=n[s])&&void 0!==t?t:this.unknownCharcode}return a}}H().set("IS_NODE",!1);var rm={class_name:"Sequential",config:{name:"sequential_1",layers:[{class_name:"Embedding",config:{input_dim:34,output_dim:16,embeddings_initializer:{class_name:"RandomUniform",config:{minval:-.05,maxval:.05,seed:null}},embeddings_regularizer:null,activity_regularizer:null,embeddings_constraint:null,mask_zero:null,input_length:null,name:"embedding_Embedding1",trainable:!0,batch_input_shape:[null,null]}},{class_name:"SimpleRNN",config:{name:"simple_rnn_SimpleRNN1",trainable:!0,units:16,activation:"relu",use_bias:!0,kernel_initializer:{class_name:"VarianceScaling",config:{scale:1,mode:"fan_avg",distribution:"normal",seed:null}},recurrent_initializer:{class_name:"Orthogonal",config:{gain:1,seed:null}},bias_initializer:{class_name:"Zeros",config:{}},kernel_regularizer:null,recurrent_regularizer:null,bias_regularizer:null,activity_regularizer:null,kernel_constraint:null,recurrent_constraint:null,bias_constraint:null,dropout:0,recurrent_dropout:0,return_sequences:!1,return_state:!1,go_backwards:!1,stateful:!1,unroll:!1}},{class_name:"Dense",config:{units:1,activation:"sigmoid",use_bias:!0,kernel_initializer:{class_name:"VarianceScaling",config:{scale:1,mode:"fan_avg",distribution:"normal",seed:null}},bias_initializer:{class_name:"Zeros",config:{}},kernel_regularizer:null,bias_regularizer:null,activity_regularizer:null,kernel_constraint:null,bias_constraint:null,name:"dense_Dense1",trainable:!0}}]},keras_version:"tfjs-layers 4.2.0",backend:"tensor_flow.js"},om=[{name:"embedding_Embedding1/embeddings",shape:[34,16],dtype:"float32"},{name:"simple_rnn_SimpleRNN1/kernel",shape:[16,16],dtype:"float32"},{name:"simple_rnn_SimpleRNN1/recurrent_kernel",shape:[16,16],dtype:"float32"},{name:"simple_rnn_SimpleRNN1/bias",shape:[16],dtype:"float32"},{name:"dense_Dense1/kernel",shape:[16,1],dtype:"float32"},{name:"dense_Dense1/bias",shape:[1],dtype:"float32"}],lm="D3HrvZUs7rxT6Vu+tVsfvPLyB70zbt695ECPvKyKWj7TnUO+JZ9pvs8MkL3/1DQ+kftzvPGZZL4aDpe8KiOnvSvRHz52vQK9mGiSPm50B72RCfM+7hW6PSOuTz7b9zG+M5MOPv/mYL7Q9Rk+aPgRvrfQuT6mQ2Q+eOawPp/PpLyM9yY+zB4APT27n75OVUk+V8y6vetFyD0zPlW+sqPfPER8Ub6J1pI+5QwEvcZktT12HLW+FSFGPU6s2ryQapW9/MNNvoK1t71R5sK8N6Y/vjqBzTtusl2+0Ks8PpZOQ74ua5U9TOIfvkpgHDxho/294hcTPkJaiL1iXTo9o28bPhnMBr69EoG8CAeCvtgxXT5kMKq+KnLfPbScM73jYjw+LTa8vSeQWj49+cU7/FH2PKtOwr5y8K29GMMdvrkIgb0wK4C8Zeq2vXlG+L15O4c+CaFGvpmCjD5guBg+0AAQPv0EjT3CdZ0+vLOBulXEAb7VVpi+WldAPpIP8T0ETFm+NcLIPZix17rKGEW+n8jxPfT8hr43TLC8esPRvX6k4D1lZ0C+WERdPo4Qab4SdWw+uWSevp7+zTjX5Xi8nw+ZvldSb7xUfke7HX01PVOV2zzFqV2+SqcNvvPUTz0nzZi9Zl+ePWj6Wr3PLjY+vbjrvSRr6b1es/w8oaLjPUC0G72spye9rsomPtW/t72QYEy9AtR6PuX44z1dLrk9k6HAPE1+Eb7w1mY+N8MSvuMLsj1qmsO6JrRAvsJowr7iA1E+udZGPDLR57xRSj8+GFSnvYNUujxIvpM8FHmHvkr8QD38Po29LslnvShYOD45FAE7vfaWPbnegruqB2W9MdUkPpskUb3YGTU+L3gwvQhAYD4ed66+qJQUvjydBr7bSam8fYz/PCTisD7GYoQ+HDxJvSaIR77s3u+8sVTkvaDBaL13FBs+Z8T4vT4aKj2d4DC7ft+GPvVXFLxGXGI9RJ9avl7RCD6ujIy+M+/zPQbAtr3B2+c9BpZcPYIBTj7QNsM95bqEPc221T3u7TO+M2PIPU/BQb78/nk+f4TmvV5Elj0VOAK+0Y+DPq0GkL364pI98CGUvjK4IL1CLoK+kohXvTS3I76BpcM9WE0Rva5vkz301Ui+CLe7vWkLnT1sjpM8EYyWPWblIryk+gI+gnQSvu9XKL7jtni9Rc/IvaonHj2sKBc+VzRovpdOpT64szY+OavnvfzjeLuBH62+OqC2OoeMBr0eJVi7ST7CPLK/3jxTOoC9BRUSPjNBaD6OIlm+7ApUPlbsWj5KIKi+J9F1Pfi88L1+JdA9a6F+PsiRub06rh2+HlXnPb5Wj774l+i6nifjvWMCtL2WnqW9pUNdvjQM4L0ZJDy9lZ+LPbJWhj2hUZO+iWF0vhq17zqKwOI9Qq6sPWo8gD3c0co9/5WaPLN6PL6HOLO8fXvUvEF2IL4QJ7S98UzCPZJTlb6VUCM+y7dqvkJXyTyxD+I9N6PXvUxuqr0jiuM9p1OgO/wUFL07zEy+n5rPvSLifbt4N5e+kbdRviF6Db0ZSjo+B+dXvqB+iT7nFI68Z9bUPU9FGT21fz4+fee2vaIHqLzRTtG8aGggPqQlpD1GORk9/FpnPjatAL60OPg8x+qAPdU74zxSk6+9lYwdPikogr6pxao99PmXvH+yEz4zu5U9IeURPXqY9LpuvYk8OGmYvFX7+TtuUaO9qg0GPph0Xr5vdYM+0deHvozgtryfgDC8DaCGPTVxHb6q0fI97pWqPOXMAj7Y9ae+fljRuoumt71vblO+UaetPcadt7yiUYi9R9x8PqXbmb4V9gK+v2jjvVsTU72VAJ29JC1vPcpy1D2uNZM9N5mlvru77rxAZSo9jZWkvv+0HD6CY6k9RvnyvLM8Wr4/Yjo+aEr4vcUQkj3Ef7+7DusLvhf0oLxUt1u+LdOWPndY+Ty5+Dq+QfqQvqgCbj7V0L68swkNviGjaz0SkyQ+h9uuvckW97rM35m+O7ERPQvQ4L2XN3a9XwqPPifY7TynN0i9enwJPWh2Tj27c02+k0bpPWtEGz4p+qs9DzsKPhlEoD7U1qM9v7SAvNgeIr7tPJM9om6CvhmNcz7pBIa9HEvlPRmEGj7SzgE9tdoAO8dkeT2N2Xm9ChofvhVPSj19rZG+A2PfPVrax72zacc9YWsTvjSKAj4inbu9GbJGvSEnt76qFeq8JsAnvZ0cO75Lk7e5G8+WPrc5Cb3RGVg+xwxfvgTMNr18pdU9U49jPaRh5rg8G2Q+iUtrObd+jT0FTYG+XgVgvKwXJr6TWuG9BWosPlr9pT6IF2G+boCIvU0FOb39ivu9aMA5viC1S714C3q+CES6Pt11j76mNqk+/btevCcEVL7z5cK+ALgyPJeTPb0+7O+7lftrPslPZz1EqIY9DWKYvdtgWL5/DwI9Q2NFvJhKcb0MMQo+NtltPWZcmT2FlVA9V5Nnvc9IJr0TXCA+nAIuPoF7xbon0SQ+Kwi8ve0ePb6O3++9k2/GvZoLlrxRDM48DwOkvEiWIz7jsgC+NYZzvTu7Jb7Jcgm8qAoyPg8zkT3o8UI+7Mt/vZsaYj7UZDm+Z4BTPBgkQr7CSTs+PKpvPbkSED3tAaW9LJ9APo74Fz62CFe8xMDCPi83F76ttk++K6FGvQkDDr42fbG+N9cbPvP1Br2CU1c+qukfvu3DJz6Vjfy8jlM9PZNaKL4Ceu29dDVCvoG7fD5qTLu75+YoPXt8GD7ey2U+KpynvemmCL1L1VC9LsfhvcoBND44he273UFiPrLzK72XXPS9ZjZGPtBwh7gwW2i+ccbxvXtoMj4Q/u49AzHBvoTjHD40AuW+OiwYP4x9JD6PGAY/KN7+Pc0xhb6OqxY9AptQvbc7Or39a9e6DJ/zPvd+iz6XX7g6kqsEP5LI1L7ICBk+1k5SP0lR0T43qYI+kbFLvcUh5L7+v90+5mnZveLTxj03yAS+phJLvW7x3b4m3J68GeeBvlrhgj05ac++0Yyfvcrz7L1/Y/i+ZjMKPhEy6j3ImRu+fRRuPkunGL5dMVG+Yd5Fv6ys1z6PXYI+JhzOvaGxDT4p38I+QcDHPtkxbb0XnjM/ogGYviZrLj291se+iNNqvpZuUb7nas8+lj4tvvyQ3D7w+FO9r4ybPs7MJD+WsIG9pGxHPqmQo75RdUG/gFs2vRXbrj7n87w9aGosPm8vDr/oUeO+2pWxPsk1RT7lvPS+YBmZvkDPU745ORi/BxbNPg83pD2KOSq9Nh0tPw6bSj+WVTk97hLcPnMDpT7GgXW8dL46vltPvb11QOu9CeYDPYDxwbx5UQ8+MnesPb+Ajj7Uv7m+qE+TvM+Qt77g88s+7940P8/1zj5p9+g+FugoPgNebT69zXg+IbhFvnHq6LsVozg+iIaBPau6Kr6tTOG+U1bhPS6zFD64rqY/FZebvhOPeL5DGXo+dwgLPjKu6z5+X78+iAsNPrs/Pb+RQoe+6MyqvWutu75ml7G+3Casvq63/b4exKi9+5lMv7V/yb4twI49cbIcv/+5/r5lWxE/78Q+PhjngT4SENI9xZKXPmmQEb9UJGK+eYE3vtOLiDxf4zo+9KX5Pl0APj9PhqA+i/wMv1iRsjzngaK+/ocBv8RUnr0hPdM+YAshv896DL1aukY+kiIJvsKhvD66FTi++84Fv5vWjL4lr6W+OLvyvba/krzwXgm9X8rUvv+XNb7jhSo/zfCAPLRlqD4Fn5S+DeQfP0847T7NIZ4+/gMAPxyfcT6VQOM+UOmWvWDtrD4TLFW9NGQSveJN9T7AuFm+MvUSv/TnFz8uw68+k05IPj26MTwDLsW+hsLFvifDqD7Z6d28z+AOv1DeZL8TnA++mrwBvT0BGL5ireW+PLbOOQjsJjzUmya/CcavOz8kwr70lmK+PHcmPsmi9r5VeAI+yly7PSGkIT6xV1Q/uHsKP4WFir4DBcc+SIJuPlP0Lb5Nufu+dKc3vk/X4L2Qvyo/jJSCPr3+Vr7NNA4/5AqcPoYisjuvO6g9JGKRPgxvQj/bUnG8yqAbP8wDO75rdkO+keIuPvrKxT4VCoQ9fx3XPih9K77kIOg99g2gPcrn4rxDzyy+TDdxPpzmHz//YWM+PIXFvTGs4z5SaaE9NAwkv4Qcub6gS3g+6Wa0vf3qJD8NDC2/q4z6PFVEob5p8yG+uSjhvjAMgD4GQ2Q/+EfRPlrsL79K2PO+FyOrPav1lT6vSzQ+nQOovRiVMD4Yfg4+weDxPv9V8b3ix407T0mFvEXdYT4DaKq+rE4YviLa2r4q/vI7hVWOvWgaV77A7QU/OU2iPp8QQT58RIA+Lbf+vo65Fz1RDRw+mv6WvdOImj4/IyY9a+vPO/pDuj6WiFe94SnbvW0cAb5HUcQ8croTvdeGIT6Q5p89/2EpPyPapj33gSS+q161vhFrSj00b5A9P6g4vssdob5sS5G+r72gvUDqCj+C5+a9lJHFPjtFxz10OYs+qXakvlUu5Trwp749nrcQPbAzwr5pCs8+UhoIvsHVdT7iw+i+UYxzPgTn5T50arg+R/4IP7kH2T2cguW+pQX+vFqQdr3z5yY+SdURProPID4CXhA9crIcP/7a4D6r/549Ly6lvXeFUb9n9xs/CC3oPrOgAj8iPwo/8nPXviKqAr8q6TQ+vrumPrdtHz8prJq+V1/oPUZWGr4Y4cU9nRopvtRCkz2jeTy+pJW0PgwDyz6XfIo+QmZevqCRSj1/pIa+KoufPllZvT5o244+nRIYP3TbM70N+8y+a7d2vcsSWj4Cdrw+AT8hPVoDwL0BxL2+G1pmPo/CZL66zSS+g2rFPvewar7nfGe+YEuevRgFIr7dyRS+KES0Pnu1p754F6s+/inJPXa3tL4Qd5A+OmbLPWvlnb75WsU9rRHMvsgqxD5MQ90+Y38LPnBkZj7fKIs9uJCHvdiuXr6D/Rw9hpVyPu9Vqr4Qzom85dP6vYymmr1yG5w+2gSMPlV5tT1D1ks+EKTZPm4gOb6ZC+w+k8EOPA8oXb6r9z2+h6Tgvm7Dvj7OzJQ+7tkIPvbDjz4TN6u9GneSPTIooD7GdRA/wYQ4vVr7b71F/QI+cRORPrRPWzxVX22+Yu2vPsHriL720za+oBlVPogMe72YNKM8r9aEO5uq1z7RegW+4aX1PqfYRD/wpfI9sVqvPCI99jpAtWC9eXJ2PBb++j6w+809iODsPfwV0b2kL7S9D+FLPQZECD4oYRA+V1Z+vjarEj5ZF/q8KJSAPkjENr7zNd28pKODPj8FPL8mgFY8kJVMvgBfQ75uooK++9TaPg/5Cr5Pzo6+1Yy3viONQL/Fvng+Bmn6vTpQkb0N7Oi94ZVHPYE2Hr7J/Rk+zQzKvL3Chj5d85o+Q/YRPrsjnj7YzJY+01w3PyVgGD6INkM+XtnevbmxiL7Z1NI+jpdgvggkdz0QnJq+35a8PZX0SL4+y78+grnOPYHzlD2VKRA/xRW4PqyCPL4Cowa/Ku+pvZabKz99894+sY/Vva/ezL1zsUw+er4IP8DL/D1qa2a+m6B3PK8Cq76mu2++gsjvvP0kBz8pWqe+SyotvKUdmz4pFXA7bkXCvbwSbj44g7c8mID4viXITL56E/G9zBVuPPD+u7wCmJc9v1nDuyyEX77G7Nq8GUwXvQJRVT3nTYY9/wK9Pct9sT1dCqU9aRsHvlmTFD2/B5M9PclmvNt2Jb8eqR2+bZhIvlmRVT4k0zU/OFSyvnCsHb/BfrK+ZZJGv10pNT8uXQk/AaVXvgbtG76M5kC+b6zpPfBICD8I1Lm8",cm={format:"layers-model",generatedBy:"TensorFlow.js tfjs-layers v4.2.0",convertedBy:null};const um="undefined"!=typeof Buffer&&("undefined"==typeof Blob||"undefined"==typeof atob||"undefined"==typeof btoa);class hm{inflect(e,n,a){return t(this,0,void 0,(function*(){const t=[],i=e.split("-");for(let e=0;e<i.length;e+=1){const s=yield this.inflectNamePart(i[e],n,a,e===i.length-1);t.push(s)}return t.join("-")}))}}const pm=/[ая]$/i,dm=/(ой|ий|ій|их)$/i;const fm=new class extends hm{constructor(e){super(),this.wordInflector=e}inflectNamePart(e,t,n){return this.wordInflector.inflect(e,{grammaticalCase:n,gender:t,applicationType:"givenName"})}}(g),mm=new class extends hm{constructor(e){super(),this.wordInflector=e}inflectNamePart(e,t,n){return this.wordInflector.inflect(e,{grammaticalCase:n,gender:t,applicationType:"patronymicName",customRuleFilter:e=>e.applicationType.includes("patronymicName")})}}(g),gm=new class{constructor(e){this.modelLoader=e,this.modelPromise=null,this.wordTransformer=new sm(20),this.familyNameClassTransformer=new im}classify(e){return t(this,0,void 0,(function*(){let t=this.getCached(e);if(null!=t)return t;const n=yield this.loadModel(),a=this.wordTransformer.encode(e),i=yield n.predict(dr([a])).data();return t=this.familyNameClassTransformer.decode(i),t}))}getCached(e){let t=null;const n=am[e.toLowerCase()];return n&&(t={wordClass:n}),t}loadModel(){return t(this,0,void 0,(function*(){return null==this.modelPromise&&(this.modelPromise=Mp(this.modelLoader)),this.modelPromise}))}}(new class{load(){return t(this,0,void 0,(function*(){const e={};if(e.modelTopology=rm,e.weightSpecs=om,e.weightData=function(e){if(um){const t=Buffer.from(e,"base64");return t.buffer.slice(t.byteOffset,t.byteOffset+t.byteLength)}const t=atob(e),n=new Uint8Array(t.length);for(let e=0;e<t.length;++e)n.set([t.charCodeAt(e)],e);return n.buffer}(lm),null!=cm){const t=cm;e.format=t.format,e.generatedBy=t.generatedBy,e.convertedBy=t.convertedBy,null!=t.signature&&(e.signature=t.signature),null!=t.userDefinedMetadata&&(e.userDefinedMetadata=t.userDefinedMetadata),null!=t.modelInitializer&&(e.modelInitializer=t.modelInitializer),null!=t.initializerSignature&&(e.initializerSignature=t.initializerSignature),null!=t.trainingConfig&&(e.trainingConfig=t.trainingConfig)}return e}))}}),vm=new class extends hm{constructor(e,t){super(),this.wordInflector=e,this.familyNameClassifier=t}inflectNamePart(e,n,a,i){return t(this,0,void 0,(function*(){if(!i&&s(e))return e;let t=null;return this.isUncertainFamilyNameClass(e,n)&&(t=yield this.familyNameClassifier.classify(e)),this.wordInflector.inflect(e,{grammaticalCase:a,gender:n,wordClass:null==t?void 0:t.wordClass,applicationType:"familyName"})}))}isUncertainFamilyNameClass(t,n){return n===e.GrammaticalGender.FEMININE&&pm.test(t)||n===e.GrammaticalGender.MASCULINE&&dm.test(t)}}(g,gm),ym=new class{constructor(e,t,n){this.givenNameInflector=e,this.patronymicNameInflector=t,this.familyNameInflector=n}inflect(e,n,a){return t(this,0,void 0,(function*(){const t={};return null!=e.givenName&&(t.givenName=yield this.givenNameInflector.inflect(e.givenName,n,a)),null!=e.patronymicName&&(t.patronymicName=yield this.patronymicNameInflector.inflect(e.patronymicName,n,a)),null!=e.familyName&&(t.familyName=yield this.familyNameInflector.inflect(e.familyName,n,a)),t}))}}
/**
     * @license
     * Copyright 2020 Google LLC. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     * http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     * =============================================================================
     */(fm,mm,vm),bm=[];function wm(){const e=[];for(const t of bm)e.push(...t.fieldNames);return e}var km="(ин|ій|ом|ам|ян|ан|ар|рт|ас|он|ін|ен|ем|ур|ип|ьд|ей|ко|ид|ст|ир|ав|сл|ис|ой|ил|им|др|ет|уб|ор|ад|ай|юб|од|юд|ол|ло|іб|ат|ун|ум|яд|іт|ик|ог|ач|ро|уг|ік|ід|то|ус|нн|ий|до|ев|ич|ух|ць|ег|сь|ів|ап|ім|зд|ац|єр|їл|рг|яр|лк|ок|іл|ох|іш|іг|ив|ук|ек|ош|иль|вір|ула|ята|зір|ива|иня|ега|лля|ьма|ука|пір|рит|мов|ага|дір|ала|ема|вит|воля|шата|ітер|біда|кита|кола|екса|лель|рава|сила|вута|урма|дота|чара|слава)$",xm="(ія|та|ая|на|да|за|са|ла|ка|ся|ра|ва|дя|ея|['’ʼ]я|ха|ма|ря|оя|га|па|дь|ня|ля|йя|ша|фа|ба|тя|ль|ут|уф|иф|iя|ста|ора|ика|їда|еса|ада|іта|іса|лла|еда|ела|іка|ида|иса|рта|ава|нда|ара|сса|кла|ера|тта|іра|ира|уда|рка|нка|мма|їла|ьда|фір|єва|вга|ета|шка|има|ата|яда|нга|зка|дра|тка|тра|уня|еля|ола|аня|бов|ила|вка|гда|ьва|чка|ога|йда|аля|лка|дка|ель|ьга|сла|ова|вла|зга|ева|зда|ька|їса|ека|кка|ода|ява|нта|рра|яра|ока|оня|кля|іва|ита|дит|хва|іга|гата|бара|лава|вара|іола|тава|уель|стер|бава|лата|ірма|фата|лара|дара|пава|мила|лола|ьоля|рита|рута|нель|ната|ніда|сава|шель|сара|зара|мара|лита|ікса|тата|цата|фота|ичара|услава|еслава|ислава|іслава|ослава|аслава|дслава|гуслава|леслава|рислава|ніслава|рослава|дислава|сеслава|чеслава|нислава|реслава|тослава|бислава|бослава|числава|лослава|тислава|діслава|наслава|гослава|едслава|дослава|біслава|цеслава)$",Sm="[иі]ч$",Nm="на$";class Tm{constructor(e){this.masculinePattern=e.masculinePattern,this.femininePattern=e.femininePattern}detect(t){const n=t.match(this.masculinePattern),a=t.match(this.femininePattern);if(null!=n&&null==a)return e.GrammaticalGender.MASCULINE;if(null==n&&null!=a)return e.GrammaticalGender.FEMININE;if(null!=n&&null!=a){const[t]=n,[i]=a;return t.length>i.length?e.GrammaticalGender.MASCULINE:e.GrammaticalGender.FEMININE}return null}}const Im=new Tm({masculinePattern:new RegExp(km,"i"),femininePattern:new RegExp(xm,"i")}),Cm=new Tm({masculinePattern:new RegExp(Sm,"i"),femininePattern:new RegExp(Nm,"i")});class $m extends TypeError{}const Am=["givenName","patronymicName","familyName"];function Em(e){return"object"==typeof e&&null!=e}function jm(n,a){return t(this,0,void 0,(function*(){const i=function(t){if(!Em(t))throw new $m("The input type must be an object.");if(!Object.values(e.GrammaticalGender).includes(t.gender))throw new $m(`The "gender" parameter must be one of the following: "${Object.values(e.GrammaticalGender).join('", "')}".`);const n=[...Am,...wm()];if(!n.some((e=>e in t&&void 0!==t[e])))throw new $m(`At least one of the following parameters must present: "${n.join('", "')}".`);for(const e of n)if(void 0!==t[e]&&"string"!=typeof t[e])throw new $m(`The "${e}" parameter must be a string.`);const a=Object.assign({},t);for(const e of n){const t=a[e];"string"==typeof t&&(a[e]=t.normalize("NFC"))}return a}(a),s=yield ym.inflect(i,i.gender,n),r=yield function(e,n){var a;return t(this,0,void 0,(function*(){const t={};for(const i of bm){const s=yield null===(a=i.afterInflect)||void 0===a?void 0:a.call(i,e,n);null!=s&&Object.assign(t,s)}return t}))}(n,i);return Object.assign(Object.assign({},s),r)}))}e.InputValidationError=$m,e.WordInflector=m,e.detectGender=function(e){return t(this,0,void 0,(function*(){const t=function(e){if(!Em(e))throw new $m("The input type must be an object.");if(!Am.some((t=>t in e&&void 0!==e[t])))throw new $m(`At least one of the following parameters must present: "${Am.join('", "')}".`);for(const t of Am)if(void 0!==e[t]&&"string"!=typeof e[t])throw new $m(`The "${t}" parameter must be a string.`);const t=Object.assign({},e);for(const e of Am){const n=t[e];"string"==typeof n&&(t[e]=n.normalize("NFC"))}return t}(e);return(n=t).patronymicName?Cm.detect(n.patronymicName.toLocaleLowerCase()):n.givenName?Im.detect(n.givenName.toLocaleLowerCase()):null;var n}))},e.inAblative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.ABLATIVE,n)}))},e.inAccusative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.ACCUSATIVE,n)}))},e.inDative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.DATIVE,n)}))},e.inGenitive=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.GENITIVE,n)}))},e.inLocative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.LOCATIVE,n)}))},e.inNominative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.NOMINATIVE,n)}))},e.inVocative=function(n){return t(this,0,void 0,(function*(){return jm(e.GrammaticalCase.VOCATIVE,n)}))},e.registerExtension=function(e){const t=e({wordInflector:g});bm.push(t)}}));
