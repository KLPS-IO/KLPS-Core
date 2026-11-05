// Conservative spelling-only substitutions. No grammar, vocabulary, numbers or inferred speech.
const spellings: Record<string,string> = {
 realize:'realise', realizes:'realises', realized:'realised', realizing:'realising', realization:'realisation',
 personalize:'personalise', personalizes:'personalises', personalized:'personalised', personalizing:'personalising', personalization:'personalisation',
 analyze:'analyse', analyzes:'analyses', analyzed:'analysed', analyzing:'analysing',
 color:'colour', colors:'colours', colorful:'colourful', colored:'coloured',
 behavior:'behaviour', behaviors:'behaviours', behavioral:'behavioural',
 favorite:'favourite', favorites:'favourites', center:'centre', centers:'centres', fiber:'fibre', fibers:'fibres',
 organize:'organise', organizes:'organises', organized:'organised', organizing:'organising', organization:'organisation', organizations:'organisations',
 recognize:'recognise', recognizes:'recognises', recognized:'recognised', recognizing:'recognising',
 normalize:'normalise', normalized:'normalised', normalization:'normalisation',
};
const pattern=new RegExp(`\\b(${Object.keys(spellings).join('|')})\\b`,'gi');
export function toBritishEnglish(text:string):string {
 return text.replace(pattern,word=>{const replacement=spellings[word.toLowerCase()];if(word===word.toUpperCase())return replacement.toUpperCase();if(word[0]===word[0].toUpperCase())return replacement[0].toUpperCase()+replacement.slice(1);return replacement;});
}
