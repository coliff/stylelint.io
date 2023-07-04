import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import { remark } from 'remark';
import remarkGFM from 'remark-gfm';
import { visit } from 'unist-util-visit';

function rewriteLink(options) {
	function visitor(node) {
		node.url = options.rewriter(node.url);
	}

	function transform(tree) {
		visit(tree, ['link'], visitor);
	}

	return transform;
}

function wrapProblemExample() {
	function visitor(node, index, parent) {
		const isValid = node.children[1]?.children[0]?.value === 'not';
		const className = isValid ? 'valid-pattern' : 'invalid-pattern';
		const wrapperStart = { type: 'html', value: `<div class="${className}">` };
		const wrapperEnd = { type: 'html', value: '</div>' };

		// Insert to the next position of the paragraph
		parent.children.splice(index + 1, 0, wrapperStart);

		const childrenLength = parent.children.length;

		// Find the end position
		let endIndex = index + 1;

		while (endIndex < childrenLength) {
			const child = parent.children[endIndex];

			if (isTrigger(child) || child.type === 'heading') {
				break;
			}

			endIndex++;
		}

		// Insert to the end position
		if (endIndex === childrenLength) {
			parent.children.push(wrapperEnd);
		} else {
			parent.children.splice(endIndex, 0, wrapperEnd);
		}
	}

	function isTrigger(node) {
		if (node.type !== 'paragraph') return false;

		if (!node.children) return false;

		// There can be an `emphasis` node with "not" between the `first` and `last` nodes
		const [first, , last] = node.children;
		const text = (first?.value ?? '').trimEnd() + (last?.value ?? '');

		return [
			'The following patterns are considered problems:',
			'The following pattern is considered a problem:',
		].includes(text);
	}

	function transform(tree) {
		visit(tree, isTrigger, visitor);
	}

	return transform;
}

/**
 * Convert GFM notes and warnings (beta) to Docusaurus Admonitions.
 *
 * @see https://docusaurus.io/docs/markdown-features/admonitions
 * @see https://github.com/facebook/docusaurus/issues/7471
 * @see https://github.com/orgs/community/discussions/16925
 */
function convertToAdmonitions() {
	const gfmToAdmonitions = new Map([
		['Note', 'note'],
		['Warning', 'caution'],
	]);

	function visitor(blockquote, index, parent) {
		const [paragraph] = blockquote.children;

		if (paragraph.type !== 'paragraph') return;

		const [strong, ...restChildren] = paragraph.children;

		if (strong.type !== 'strong') return;

		const [text] = strong.children;
		const gfmType = text?.value;
		const admType = gfmToAdmonitions.get(gfmType);

		if (!admType) return;

		// Trim a whitespace at the beginning of a sentence.
		restChildren.forEach((child, i) => {
			if (i === 0 && child.value) {
				child.value = child.value.trimStart();
			}
		});

		// Insert new nodes after the current one.
		parent.children.splice(
			index + 1,
			0,
			{ type: 'paragraph', children: [{ type: 'text', value: `:::${admType} ${gfmType}` }] },
			{ type: 'paragraph', children: restChildren },
			{ type: 'paragraph', children: [{ type: 'text', value: ':::' }] },
		);

		// Delete an old node.
		parent.children.splice(index, 1);
	}

	function transform(tree) {
		visit(tree, ['blockquote'], visitor);
	}

	return transform;
}

function makeRuleSymbolsAccessbile() {
	const symbols = new Map([
		['✅', 'Standard'],
		['🔧', 'Autofixable'],
	]);

	function visitor(node, _index, parent) {
		const symbol = node.value;
		const name = symbols.get(symbol);

		parent.children = [
			{
				type: 'html',
				value: `<span title="${name}">${symbol}</span>`,
			},
		];
	}

	function transform(tree) {
		const test = [...symbols.keys()].map((value) => ({ type: 'text', value }));

		visit(tree, test, visitor);
	}

	return transform;
}

function processMarkdown(file, { rewriter }) {
	const content = remark()
		.use(remarkGFM)
		.use(rewriteLink, { rewriter })
		.use(wrapProblemExample)
		.use(convertToAdmonitions)
		.use(makeRuleSymbolsAccessbile)
		.processSync(fs.readFileSync(file, 'utf8'))
		.toString();

	// Add Docusaurus-specific fields. See https://docusaurus.io/docs/en/doc-markdown
	let title = content.match(/\n?# ([^\n]+)\n/)[1];
	let slug;

	const titleToSidebarLabel = {
		Stylelint: 'Home',
	};

	const sidebarLabel = titleToSidebarLabel[title] || title;

	// Check for homepage
	if (title === 'Stylelint') {
		title = sidebarLabel;
		slug = '/';
	}

	const meta = [
		['title', title],
		['sidebar_label', sidebarLabel],
	];

	if (slug) meta.push(['slug', slug]);

	let frontMatter = '---\n';

	for (const item of meta) {
		frontMatter += `${item[0]}: ${item[1]}\n`;
	}

	frontMatter += '---';

	return `${frontMatter}\n\n${content}`;
}

function main(outputDir) {
	fs.rmSync(outputDir, { force: true, recursive: true });
	fs.mkdirSync(outputDir);

	glob.sync('node_modules/stylelint/*.md').forEach((file) => {
		let output = processMarkdown(file, {
			rewriter: (url) => url.replace(/^\/?docs\//, '/').replace('README.md', 'index.md'),
		});

		const outputFile = path.join(
			outputDir,
			file.replace('node_modules/stylelint', '').replace('README.md', 'index.md'),
		);

		fs.mkdirSync(path.dirname(outputFile), { recursive: true });

		fs.writeFileSync(outputFile, output, 'utf8');
	});

	glob.sync('node_modules/stylelint/docs/**/!(toc).md').forEach((file) => {
		const output = processMarkdown(file, {
			rewriter: (url) =>
				url
					.replace(
						'../../lib/rules/index.js',
						'https://github.com/stylelint/stylelint/blob/main/lib/rules/index.js',
					)
					.replace('../../CHANGELOG.md', '../CHANGELOG.md')
					.replace('../../VISION.md', '../VISION.md')
					.replace('../../lib/rules/', '/user-guide/rules/')
					.replace('/README.md', '.md')
					.replace('CONTRIBUTING.md', 'CONTRIBUTING'),
		});

		const outputFile = path.join(outputDir, file.replace('node_modules/stylelint/docs', ''));

		fs.mkdirSync(path.dirname(outputFile), { recursive: true });

		fs.writeFileSync(outputFile, output, 'utf8');
	});

	glob.sync('node_modules/stylelint/lib/rules/**/*.md').forEach((file) => {
		const output = processMarkdown(file, {
			rewriter: (url) =>
				url
					.replace(/\.\.\/([a-z-]+)\/README.md/, '$1.md')
					.replace(/\.\.\/\.\.\/\.\.\/docs\/user-guide\/([a-z-/]+)\.md/, '../$1.md'),
		});

		const outputFile = path.join(
			outputDir,
			file
				.replace('node_modules/stylelint/lib/rules', 'user-guide/rules')
				.replace('/README.md', '.md'),
		);

		fs.mkdirSync(path.dirname(outputFile), { recursive: true });

		fs.writeFileSync(outputFile, output, 'utf8');
	});

	glob.sync('node_modules/stylelint/*.png').forEach((imagePath) => {
		const dest = path.join(outputDir, imagePath.replace('node_modules/stylelint/', ''));

		fs.copyFileSync(imagePath, dest);
	});

	console.log('Documents have been generated.'); // eslint-disable-line no-console
}

main(process.argv[2]);
