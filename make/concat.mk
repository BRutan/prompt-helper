# Path: make/concat.mk
# Project source concatenation convenience targets
# Include in your Makefile, or invoke via `make -f make/concat.mk <target>`.

# @make-param concat-files LINE_PATTERN Optional; regex. Only files with at least one matching line are output (applies to DIR, FILES and GLOB inputs). Searched with ripgrep (Python-style syntax; lookaround/backreferences via PCRE2) when installed, else grep -P, else grep -E.
# @make-param concat-files LINE_PATTERN_MAX_BYTES Optional; with LINE_PATTERN, skip files larger than this many bytes (default 10485760; 0 = no limit).
# @make-param concat-files LINE_PATTERN_TOOL Optional; force rg, grep-P or grep-E instead of the fastest one available.
.PHONY: concat-files
concat-files: SHELL := /bin/bash
concat-files:
	@set -euo pipefail; \
	input_arg="$(DIR)"; \
	files_arg="$(FILES)"; \
	glob_arg="$(GLOB)"; \
	output_arg="$(OUTPUT)"; \
	append_mode="$(APPEND)"; \
	pipe_input="$(PIPE)"; \
	recursive="$(RECURSIVE)"; \
	pattern="$(PATTERN)"; \
	exts_arg="$(EXTS)"; \
	excl_dirs_arg="$(EXCL_DIRS)"; \
	chunk_size="$(CHUNK_SIZE)"; \
	line_pattern='$(subst ','"'"',$(value LINE_PATTERN))'; \
	line_pattern_max_bytes="$(or $(strip $(LINE_PATTERN_MAX_BYTES)),10485760)"; \
	if ! [[ "$$line_pattern_max_bytes" =~ ^[0-9]+$$ ]]; then \
		echo "ERROR: LINE_PATTERN_MAX_BYTES must be a non-negative integer (got: $$line_pattern_max_bytes)." >&2; \
		exit 2; \
	fi; \
	line_pattern_tool="$(strip $(LINE_PATTERN_TOOL))"; \
	line_pattern_grep=""; \
	line_pattern_jobs="$$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"; \
	if [[ -n "$$line_pattern" ]]; then \
		if [[ -z "$$line_pattern_tool" ]]; then \
			if command -v rg >/dev/null 2>&1; then line_pattern_tool=rg; \
			else \
				for candidate_grep in ggrep grep; do \
					if command -v "$$candidate_grep" >/dev/null 2>&1 && printf 'x\n' | "$$candidate_grep" -qP 'x' 2>/dev/null; then \
						line_pattern_tool=grep-P; line_pattern_grep="$$candidate_grep"; break; \
					fi; \
				done; \
				if [[ -z "$$line_pattern_tool" ]]; then \
					line_pattern_tool=grep-E; \
					echo "WARNING: neither ripgrep nor a grep with -P is installed; LINE_PATTERN is matched as a POSIX extended regex (grep -E). Install ripgrep (brew install ripgrep) for Python-style patterns and the fastest search." >&2; \
				fi; \
			fi; \
		fi; \
		case "$$line_pattern_tool" in \
			rg) command -v rg >/dev/null 2>&1 || { echo "ERROR: LINE_PATTERN_TOOL=rg but ripgrep is not installed." >&2; exit 2; } ;; \
			grep-P) if [[ -z "$$line_pattern_grep" ]]; then if command -v ggrep >/dev/null 2>&1; then line_pattern_grep=ggrep; else line_pattern_grep=grep; fi; fi ;; \
			grep-E) line_pattern_grep=grep ;; \
			*) echo "ERROR: LINE_PATTERN_TOOL must be rg, grep-P or grep-E (got: $$line_pattern_tool)." >&2; exit 2 ;; \
		esac; \
		line_pattern_rc=0; \
		case "$$line_pattern_tool" in \
			rg) rg --no-config --engine auto -q -e "$$line_pattern" -- /dev/null >/dev/null 2>&1 || line_pattern_rc=$$? ;; \
			grep-P) "$$line_pattern_grep" -qP -e "$$line_pattern" -- /dev/null >/dev/null 2>&1 || line_pattern_rc=$$? ;; \
			grep-E) "$$line_pattern_grep" -qE -e "$$line_pattern" -- /dev/null >/dev/null 2>&1 || line_pattern_rc=$$? ;; \
		esac; \
		if [[ "$$line_pattern_rc" -ge 2 ]]; then \
			echo "ERROR: LINE_PATTERN is not a valid regex for $$line_pattern_tool: $$line_pattern" >&2; \
			exit 2; \
		fi; \
	fi; \
	if [[ -z "$$input_arg" && -z "$$files_arg" && -z "$$glob_arg" && "$$pipe_input" != "1" ]]; then \
		echo "ERROR: provide DIR=<dir[,dir...]>, FILES=<file[,file...]>, GLOB=<pattern[,pattern...]>, or PIPE=1 to consume stdin." >&2; \
		exit 2; \
	fi; \
	if [[ -z "$$output_arg" ]]; then \
		output_arg="concatenated_files.txt"; \
	fi; \
	if [[ -n "$$append_mode" && "$$append_mode" != "0" && "$$append_mode" != "1" ]]; then \
		echo "ERROR: APPEND must be 0 or 1 (got: $$append_mode)." >&2; \
		exit 2; \
	fi; \
	if [[ -n "$$chunk_size" ]]; then \
		if ! [[ "$$chunk_size" =~ ^[1-9][0-9]*$$ ]]; then \
			echo "ERROR: CHUNK_SIZE must be a positive integer (got: $$chunk_size)." >&2; \
			exit 2; \
		fi; \
		if [[ "$$pipe_input" == "1" ]]; then \
			echo "ERROR: CHUNK_SIZE applies to DIR/FILES inputs and cannot be combined with PIPE=1." >&2; \
			exit 2; \
		fi; \
		if [[ "$$output_arg" == "-" ]]; then \
			echo "ERROR: CHUNK_SIZE requires a file OUTPUT so chunk progress can be tracked." >&2; \
			exit 2; \
		fi; \
	fi; \
	stdout_mode=0; \
	output_tmp=""; \
	repo_root="$$(pwd -P)"; \
	state_dir="$$repo_root/.concat-files-chunks"; \
	chunk_root_dir="$$repo_root/concat_chunks"; \
	args_hash=""; \
	chunk_output_dir=""; \
	if [[ -n "$$chunk_size" ]]; then \
		args_hash="$$(python3 -c 'import hashlib,sys; print(hashlib.sha256("\\0".join(sys.argv[1:]).encode()).hexdigest())' "$$input_arg" "$$files_arg" "$$glob_arg" "$$output_arg" "$$append_mode" "$$recursive" "$$pattern" "$$exts_arg" "$$excl_dirs_arg" "$$chunk_size" "$$line_pattern")"; \
		chunk_output_dir="$$chunk_root_dir/$$args_hash"; \
		mkdir -p "$$chunk_output_dir"; \
		output=""; \
	elif [[ "$$output_arg" == "-" ]]; then \
		stdout_mode=1; \
		output_tmp="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-output.XXXXXX")"; \
		output="$$output_tmp"; \
	else \
		output="$$(python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$$output_arg")"; \
		if [[ -d "$$output" ]]; then \
			echo "ERROR: OUTPUT points to a directory: $$output" >&2; \
			echo "Provide a filename, for example OUTPUT=frontend_files.txt, or OUTPUT=- for stdout." >&2; \
			exit 2; \
		fi; \
	fi; \
	if [[ -d "$$state_dir" ]]; then \
		while IFS= read -r state_file; do \
			[[ -f "$$state_file" ]] || continue; \
			if grep -qx 'COMPLETE=1' "$$state_file" 2>/dev/null; then \
				rm -f "$$state_file"; \
			fi; \
		done < <(find "$$state_dir" -maxdepth 1 -type f -name '*.state' -print 2>/dev/null || true); \
		rmdir "$$state_dir" 2>/dev/null || true; \
	fi; \
	roots_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-roots.XXXXXX")"; \
	files_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-explicit.XXXXXX")"; \
	candidates_raw="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-candidates-raw.XXXXXX")"; \
	candidates_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-candidates.XXXXXX")"; \
	selected_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-selected.XXXXXX")"; \
	line_filtered_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-line-filtered.XXXXXX")"; \
	line_matches_file="$$(mktemp "$${TMPDIR:-/tmp}/concat-files-line-matches.XXXXXX")"; \
	trap 'rm -f "$$roots_file" "$$files_file" "$$candidates_raw" "$$candidates_file" "$$selected_file" "$$line_filtered_file" "$$line_matches_file" "$$output_tmp"' EXIT; \
	if [[ -n "$$input_arg" ]]; then \
		IFS=',' read -r -a input_dirs <<< "$$input_arg"; \
		for input_dir in "$${input_dirs[@]}"; do \
			input_dir="$$(printf '%s' "$$input_dir" | sed 's/^[[:space:]]*//;s/[[:space:]]*$$//')"; \
			if [[ -z "$$input_dir" ]]; then \
				echo "ERROR: DIR contains an empty directory entry: $$input_arg" >&2; \
				exit 2; \
			fi; \
			if [[ ! -d "$$input_dir" ]]; then \
				echo "ERROR: DIR entry is not a directory: $$input_dir" >&2; \
				exit 2; \
			fi; \
			root="$$(cd "$$input_dir" && pwd -P)"; \
			printf '%s\n' "$$root" >> "$$roots_file"; \
		done; \
	fi; \
	if [[ -n "$$files_arg" ]]; then \
		IFS=',' read -r -a input_files <<< "$$files_arg"; \
		for input_file in "$${input_files[@]}"; do \
			input_file="$$(printf '%s' "$$input_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$$//')"; \
			if [[ -z "$$input_file" ]]; then \
				echo "ERROR: FILES contains an empty file entry: $$files_arg" >&2; \
				exit 2; \
			fi; \
			if [[ ! -f "$$input_file" ]]; then \
				echo "ERROR: FILES entry is not a file: $$input_file" >&2; \
				exit 2; \
			fi; \
			file="$$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$$input_file")"; \
			printf '%s\n' "$$file" >> "$$files_file"; \
		done; \
	fi; \
	if [[ -n "$$glob_arg" ]]; then \
	    IFS=',' read -r -a input_globs <<< "$$glob_arg"; \
	    for input_glob in "$${input_globs[@]}"; do \
	        input_glob="$$(printf '%s' "$$input_glob" | sed 's/^[[:space:]]*//;s/[[:space:]]*$$//')"; \
	        if [[ -z "$$input_glob" ]]; then \
	            echo "ERROR: GLOB contains an empty pattern: $$glob_arg" >&2; \
	            exit 2; \
	        fi; \
	        matched=0; \
	        while IFS= read -r -d '' glob_file; do \
	            printf '%s\n' "$$glob_file" >> "$$files_file"; \
	            matched=1; \
	        done < <(python3 -c 'import glob,os,sys; [sys.stdout.buffer.write(os.path.realpath(p).encode()+b"\0") for p in glob.glob(sys.argv[1], recursive=True) if os.path.isfile(p)]' "$$input_glob"); \
	        if [[ "$$matched" != "1" ]]; then \
	            echo "ERROR: GLOB matched no files: $$input_glob" >&2; \
	            exit 2; \
	        fi; \
	    done; \
	fi; \
	if [[ -s "$$files_file" ]]; then \
	    LC_ALL=C sort -u "$$files_file" -o "$$files_file"; \
	fi; \
	normalize_excluded_pattern() { \
		root="$$1"; \
		excl_pattern="$$2"; \
		excl_pattern="$$(printf '%s' "$$excl_pattern" | sed 's/^[[:space:]]*//;s/[[:space:]]*$$//;s:/*$$::')"; \
		[[ -z "$$excl_pattern" ]] && { printf '%s' ""; return 0; }; \
		case "$$excl_pattern" in ./*) printf '%s' "$$excl_pattern"; return 0 ;; esac; \
		case "$$excl_pattern" in */*) ;; *) printf '%s' "$$excl_pattern"; return 0 ;; esac; \
		case "$$excl_pattern" in \
			*'*'*|*'?'*|*'['*) ;; \
			*) \
				abs_excl="$$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$$excl_pattern")"; \
				case "$$abs_excl" in \
					"$$root") excl_pattern="." ;; \
					"$$root"/*) excl_pattern="$${abs_excl#$$root/}" ;; \
				esac; \
				;; \
		esac; \
		printf '%s' "$$excl_pattern"; \
	}; \
	find_candidates() { \
		root="$$1"; \
		max_depth="$$2"; \
		find_args=("$$root"); \
		if [[ "$$max_depth" == "1" ]]; then find_args+=( -maxdepth 1 ); fi; \
		prune_args=( -name .git -o ); \
		if [[ "$$state_dir" == "$$root"/* ]]; then prune_args+=( -path "$$state_dir" -o ); fi; \
		if [[ "$$chunk_root_dir" == "$$root"/* ]]; then prune_args+=( -path "$$chunk_root_dir" -o ); fi; \
		if [[ -n "$$excl_dirs_arg" ]]; then \
			IFS=',' read -r -a excluded_patterns <<< "$$excl_dirs_arg"; \
			for excl_pattern in "$${excluded_patterns[@]}"; do \
				excl_pattern="$$(normalize_excluded_pattern "$$root" "$$excl_pattern")"; \
				[[ -z "$$excl_pattern" || "$$excl_pattern" == "." ]] && continue; \
				if [[ "$$excl_pattern" == ./* ]]; then \
					prune_args+=( -path "$$root/$${excl_pattern#./}" -o ); \
				elif [[ "$$excl_pattern" == */* ]]; then \
					prune_args+=( -path "$$root/$$excl_pattern" -o ); \
				else \
					prune_args+=( -name "$$excl_pattern" -o ); \
				fi; \
			done; \
		fi; \
		if [[ "$${#prune_args[@]}" -gt 0 ]]; then \
			last_index=$$(($${#prune_args[@]} - 1)); \
			unset "prune_args[$$last_index]"; \
			find_args+=( \( -type d \( "$${prune_args[@]}" \) -prune \) -o ); \
		fi; \
		find_args+=( -type f ); \
		if [[ -n "$$pattern" ]]; then find_args+=( -name "$$pattern" ); fi; \
		if [[ -n "$$exts_arg" ]]; then \
			ext_args=(); \
			IFS=',' read -r -a requested_exts <<< "$$exts_arg"; \
			for ext in "$${requested_exts[@]}"; do \
				ext="$$(printf '%s' "$$ext" | sed 's/^[[:space:]]*//;s/[[:space:]]*$$//')"; \
				[[ -z "$$ext" ]] && continue; \
				ext="$${ext#.}"; \
				ext_args+=( -name "*.$$ext" -o -name "$$ext" -o ); \
			done; \
			if [[ "$${#ext_args[@]}" -gt 0 ]]; then \
				last_index=$$(($${#ext_args[@]} - 1)); \
				unset "ext_args[$$last_index]"; \
				find_args+=( \( "$${ext_args[@]}" \) ); \
			fi; \
		fi; \
		find_args+=( -print0 ); \
		find "$${find_args[@]}"; \
	}; \
	add_candidate() { \
		root="$$1"; \
		file="$$2"; \
		explicit="$${3:-0}"; \
		[[ -n "$$output" && "$$file" == "$$output" ]] && return 0; \
		case "$$file" in "$$state_dir"/*|"$$chunk_root_dir"/*) return 0 ;; esac; \
		: "DIR candidates are already filtered by find_candidates; explicit FILES intentionally bypass PATTERN/EXTS/EXCL_DIRS."; \
		printf '%s\t%s\t%s\n' "$$explicit" "$$root" "$$file"; \
	}; \
	while IFS= read -r root; do \
		[[ -z "$$root" ]] && continue; \
		printf 'Scanning directory: %s\n' "$$root" >&2; \
		if [[ "$$recursive" == "1" ]]; then scan_depth=0; else scan_depth=1; fi; \
		: "One awk pass formats every path found (no per-file shell work); the output, state and chunk paths are dropped like add_candidate does."; \
		{ find_candidates "$$root" "$$scan_depth" || true; } | tr '\0' '\n' | \
			awk -v root="$$root" -v out="$$output" -v state="$$state_dir/" -v chunks="$$chunk_root_dir/" \
				'BEGIN { OFS = "\t" } $$0 != "" && $$0 != out && index($$0, state) != 1 && index($$0, chunks) != 1 { print "0", root, $$0 }' \
			>> "$$candidates_raw"; \
	done < "$$roots_file"; \
	if [[ -s "$$files_file" ]]; then \
		while IFS= read -r file; do \
			[[ -z "$$file" ]] && continue; \
			case "$$file" in "$$repo_root"/*) root="$$repo_root" ;; *) root="$$(dirname "$$file")" ;; esac; \
			add_candidate "$$root" "$$file" 1; \
		done < "$$files_file" >> "$$candidates_raw"; \
	fi; \
	LC_ALL=C sort "$$candidates_raw" > "$$candidates_file"; \
	line_pattern_summary=""; \
	if [[ -n "$$line_pattern" ]]; then \
		line_pattern_started=$$SECONDS; \
		line_pattern_candidates="$$(wc -l < "$$candidates_file" | tr -d ' ')"; \
		printf 'LINE_PATTERN: searching %s candidate file(s) with %s...\n' "$$line_pattern_candidates" "$$line_pattern_tool" >&2; \
		: "Paths only (everything after the second tab), NUL-separated; files over LINE_PATTERN_MAX_BYTES are dropped with one find pass. ripgrep searches explicitly named binary files, so its matches go through grep -I, which drops binary files."; \
		{ \
			awk '{ sub(/^[^\t]*\t[^\t]*\t/, ""); printf "%s%c", $$0, 0 }' "$$candidates_file" | \
			if [[ "$$line_pattern_max_bytes" != "0" ]]; then xargs -0 -r sh -c 'find "$$@" -prune -type f ! -size +'"$$line_pattern_max_bytes"'c -print0' sh; else cat; fi | \
			case "$$line_pattern_tool" in \
				rg) xargs -0 -r rg --no-config --engine auto --files-with-matches --null --no-messages --no-ignore --hidden -e "$$line_pattern" -- | xargs -0 -r grep -lIs --null -e '' -- ;; \
				grep-P) xargs -0 -r -P "$$line_pattern_jobs" -n 256 "$$line_pattern_grep" -lIsP --null -e "$$line_pattern" -- ;; \
				grep-E) xargs -0 -r -P "$$line_pattern_jobs" -n 256 "$$line_pattern_grep" -lIsE --null -e "$$line_pattern" -- ;; \
			esac; \
		} > "$$line_matches_file" || true; \
		tr '\0' '\n' < "$$line_matches_file" | \
			awk 'NR == FNR { matched[$$0] = 1; next } { path = $$0; sub(/^[^\t]*\t[^\t]*\t/, "", path); if (path in matched) print }' - "$$candidates_file" \
			> "$$line_filtered_file"; \
		mv -f "$$line_filtered_file" "$$candidates_file"; \
		line_pattern_summary="$$(wc -l < "$$candidates_file" | tr -d ' ') of $$line_pattern_candidates candidate files with a matching line; $$line_pattern_tool, $$((SECONDS - line_pattern_started))s"; \
	fi; \
	total_files="$$(wc -l < "$$candidates_file" | tr -d ' ')"; \
	state_file=""; \
	chunk_number=1; \
	total_chunks=1; \
	if [[ -n "$$chunk_size" ]]; then \
		mkdir -p "$$state_dir" "$$chunk_output_dir"; \
		state_file="$$state_dir/$$args_hash.state"; \
		candidate_hash="$$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$$candidates_file")"; \
		next_chunk=0; \
		if [[ -f "$$state_file" ]]; then \
			stored_hash="$$(sed -n 's/^CANDIDATE_HASH=//p' "$$state_file" | head -n1)"; \
			stored_next="$$(sed -n 's/^NEXT_CHUNK=//p' "$$state_file" | head -n1)"; \
			if [[ "$$stored_hash" == "$$candidate_hash" && "$$stored_next" =~ ^[0-9]+$$ ]]; then \
				next_chunk="$$stored_next"; \
			else \
				rm -f "$$chunk_output_dir"/concatenated_files_*.txt; \
			fi; \
		fi; \
		if [[ "$$total_files" -eq 0 ]]; then \
			: > "$$selected_file"; \
			total_chunks=0; \
			chunk_number=0; \
			rm -f "$$state_file"; \
			output="$$chunk_output_dir/concatenated_files_0.txt"; \
		else \
			total_chunks=$$(( (total_files + chunk_size - 1) / chunk_size )); \
			if [[ "$$next_chunk" -ge "$$total_chunks" ]]; then next_chunk=0; fi; \
			chunk_number=$$((next_chunk + 1)); \
			start_line=$$((next_chunk * chunk_size + 1)); \
			end_line=$$((start_line + chunk_size - 1)); \
			sed -n "$${start_line},$${end_line}p" "$$candidates_file" > "$$selected_file"; \
			output="$$chunk_output_dir/concatenated_files_$${chunk_number}.txt"; \
		fi; \
	else \
		cp "$$candidates_file" "$$selected_file"; \
	fi; \
	emit_file() { \
		root="$$1"; file="$$2"; \
		printf '\n================================================================================\n' >> "$$output"; \
		printf 'SOURCE_DIR: %s\n' "$$root" >> "$$output"; \
		printf 'FILE: %s\n' "$${file#$$root/}" >> "$$output"; \
		printf '================================================================================\n\n' >> "$$output"; \
		cat "$$file" >> "$$output"; \
		printf '\n' >> "$$output"; \
	}; \
	log_status() { if [[ "$$stdout_mode" == "1" ]]; then printf '%s\n' "$$*" >&2; else printf '%s\n' "$$*"; fi; }; \
	if [[ "$$stdout_mode" != "1" ]]; then mkdir -p "$$(dirname "$$output")"; fi; \
	if [[ "$$stdout_mode" == "1" || "$$append_mode" != "1" ]]; then : > "$$output"; else touch "$$output"; fi; \
	if [[ "$$pipe_input" == "1" ]]; then \
		if [[ -t 0 ]]; then echo "ERROR: PIPE=1 expects concatenated input on stdin." >&2; exit 2; fi; \
		cat >> "$$output"; \
		if [[ -s "$$output" ]]; then printf '\n' >> "$$output"; fi; \
	fi; \
	last_root=""; \
	explicit_header=0; \
	while IFS=$$'\t' read -r explicit root file; do \
		[[ -z "$$file" ]] && continue; \
		if [[ "$$explicit" == "1" ]]; then \
			if [[ "$$explicit_header" == "0" ]]; then \
				printf '\n################################################################################\n' >> "$$output"; \
				printf 'EXPLICIT FILES\n' >> "$$output"; \
				printf '################################################################################\n' >> "$$output"; \
				explicit_header=1; \
			fi; \
		else \
			if [[ "$$root" != "$$last_root" ]]; then \
				printf '\n################################################################################\n' >> "$$output"; \
				printf 'SOURCE DIRECTORY: %s\n' "$$root" >> "$$output"; \
				printf '################################################################################\n' >> "$$output"; \
				last_root="$$root"; \
			fi; \
		fi; \
		emit_file "$$root" "$$file"; \
	done < "$$selected_file"; \
	if [[ -n "$$chunk_size" && "$$total_files" -gt 0 ]]; then \
		next_chunk=$$chunk_number; \
		complete=0; \
		if [[ "$$chunk_number" -ge "$$total_chunks" ]]; then complete=1; next_chunk=0; fi; \
		printf 'CANDIDATE_HASH=%s\nNEXT_CHUNK=%s\nCOMPLETE=%s\n' "$$candidate_hash" "$$next_chunk" "$$complete" > "$$state_file"; \
	fi; \
	if [[ "$$stdout_mode" == "1" ]]; then cat "$$output"; fi; \
	if [[ "$$pipe_input" == "1" ]]; then log_status "Included piped stdin."; fi; \
	if [[ -n "$$input_arg" ]]; then if [[ "$$recursive" == "1" ]]; then log_status "Included recursively concatenated directories: $$input_arg"; else log_status "Included directories: $$input_arg"; fi; fi; \
	if [[ -n "$$files_arg" ]]; then log_status "Included explicit files: $$files_arg"; fi; \
	if [[ -n "$$glob_arg" ]]; then log_status "Included glob pattern(s): $$glob_arg"; fi; \
	if [[ -n "$$exts_arg" ]]; then log_status "Extension filter for DIR inputs: $$exts_arg"; fi; \
	if [[ -n "$$excl_dirs_arg" ]]; then log_status "Excluded directory patterns for DIR inputs: $$excl_dirs_arg"; fi; \
	if [[ -n "$$line_pattern" ]]; then log_status "Line pattern: $$line_pattern (kept $$line_pattern_summary)"; fi; \
	if [[ -n "$$chunk_size" ]]; then \
		selected_count="$$(wc -l < "$$selected_file" | tr -d ' ')"; \
		log_status "Arguments hash: $$args_hash"; \
		log_status "Chunk directory: $$chunk_output_dir"; \
		log_status "Chunk: $$chunk_number/$$total_chunks ($$selected_count of $$total_files files; CHUNK_SIZE=$$chunk_size)"; \
		if [[ "$$chunk_number" -eq "$$total_chunks" && "$$total_chunks" -gt 0 ]]; then log_status "Chunk cycle complete; state will be removed before the next concat-files invocation."; fi; \
	fi; \
	if [[ "$$append_mode" == "1" && "$$stdout_mode" != "1" ]]; then log_status "Append mode: enabled"; fi; \
	if [[ "$$stdout_mode" == "1" ]]; then log_status "Output: stdout"; else log_status "Output: $$output"; fi

# Recursively snapshot the project without the root data/, dist, or caches.
CONCAT_ALL_FILES_EXTS := Dockerfile,Dockerfile.dockerignore,py,js,tsx,go,sh,yml,html,json,mjs,sql
CONCAT_ALL_FILES_EXCL_DIRS := ./data,dist,cache,caches,.cache,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache,node_modules,.next,venv,.venv

.PHONY: concat-all-files
# @make-param concat-all-files OUTPUT Optional output file, or - for stdout (without chunking).
# @make-param concat-all-files CHUNK_SIZE Optional number of files per chunk.
# @make-param concat-all-files LINE_PATTERN Optional regex restricting concatenated files.
concat-all-files: ## Recursively concatenate source and config, ignoring root data, dist and cache directories
	$(MAKE) --no-print-directory -f make/concat.mk concat-files DIR=. RECURSIVE=1 EXTS='$(CONCAT_ALL_FILES_EXTS)' EXCL_DIRS='$(CONCAT_ALL_FILES_EXCL_DIRS)' CHUNK_SIZE="$(CHUNK_SIZE)"
